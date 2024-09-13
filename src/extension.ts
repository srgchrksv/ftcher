import * as vscode from "vscode";
import * as anthropic from "@anthropic-ai/sdk";
import { MessageParam } from "@anthropic-ai/sdk/resources/messages";

const FTCHER_PARTICIPANT_ID = "ftcher.chat";
let messagesHistory: MessageParam[] = [];
let apiKey: string | undefined;
interface FtcherChatResult extends vscode.ChatResult {
  metadata: {
    command: string;
  };
}

let client: anthropic.Anthropic;
interface TextDelta {
  type: "text_delta";
  text: string;
}

interface InputJSONDelta {
  type: "input_json_delta";
}

interface RangeObject {
  c: vscode.Position;
  e: vscode.Position;
}

interface ReferenceValue {
  uri: string;
  range: RangeObject;
}

function isTextDelta(delta: TextDelta | InputJSONDelta): delta is TextDelta {
  return (delta as TextDelta).text !== undefined;
}
async function initClient() {
  apiKey = "";
  const input = await vscode.window.showInputBox({
    prompt: "Enter your API key",
    password: true,
  });

  if (input != undefined && input.length > 0) {
    apiKey = input;
    client = new anthropic.Anthropic({
      apiKey: apiKey as string,
    });
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Define a Cat chat handler.
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<FtcherChatResult | undefined> => {
    if (request.command === "anthropic") {
      stream.progress("Starting anthropic chat...");

      if (!client || !client.apiKey) {
        stream.markdown(
          "Enter API Key to start the chat in the popup window on top\n\n"
        );
        await initClient();
        if (client && apiKey) {
          stream.markdown("Wof wof! Lets fetch stuff");
        } else {
          stream.markdown(
            "Client not initialized. Check your key or connection and try again."
          );
        }
        return;
      }
      try {
        let code = "";
        if (typeof request.references.values === "function") {
          for (const reference of request.references.values()) {
            const value = reference.value as ReferenceValue;
            const uri = vscode.Uri.parse(value.uri);
            console.log("uri.path: ", uri.path);

            if (value.range) {
              await vscode.workspace.openTextDocument(uri).then((document) => {
                console.log("range: ", value.range);
                const { c: start, e: end } = value.range;

                // Convert the start and end positions to vscode.Position objects
                const startPos = new vscode.Position(
                  start.line,
                  start.character
                );
                const endPos = new vscode.Position(end.line, end.character);

                const range = new vscode.Range(startPos, endPos);
                code = document.getText(range);
                console.log("Selected code:", code);
              });
            } else {
              await vscode.workspace
                .openTextDocument(vscode.Uri.parse(reference.id))
                .then((document) => {
                  code = document.getText();
                  console.log("Entire file content:", code);
                });
            }
          }
        } else {
          console.error("request.references.values is not a function");
        }

        const prompt = code
          ? `code:${code}\nuser:${request.prompt} `
          : request.prompt;
        messagesHistory.push({ role: "user", content: prompt });
        console.log("messageHistory: ", messagesHistory);
        const response = client.messages.stream({
          messages: messagesHistory,
          model: "claude-3-5-sonnet-20240620",
          max_tokens: 1024,
        });
        let finalMessage = "";
        for await (const fragment of response) {
          console.log("fragment: ", fragment);

          let fragmentStr = "";
          if (typeof fragment === "object") {
            if (fragment.type === "content_block_delta" && fragment.delta) {
              if (isTextDelta(fragment.delta)) {
                fragmentStr = fragment.delta.text;
                finalMessage += fragmentStr;
              }
            }
          }
          stream.markdown(fragmentStr);
        }

        messagesHistory.push({
          role: "assistant",
          content: finalMessage,
        });
      } catch (err: any) {
        messagesHistory = [];
        console.error("Error in anthropic chat:", logger, err);

        handleError(logger, err, stream);
        const statusCode = err.status;
        if (statusCode >= 400 && statusCode < 500) {
          await initClient();
        }

        return;
      }
      logger.logUsage("request", { kind: "anthropic" });
      return { metadata: { command: "anthropic" } };
    }
  };

  // Chat participants appear as top-level options in the chat input
  // when you type `@`, and can contribute sub-commands in the chat input
  // that appear when you type `/`.
  const ftcher = vscode.chat.createChatParticipant(
    FTCHER_PARTICIPANT_ID,
    handler
  );
  ftcher.iconPath = vscode.Uri.joinPath(context.extensionUri, "ftcher.jpeg");
}

const logger = vscode.env.createTelemetryLogger({
  sendEventData(eventName, data) {
    // Capture event telemetry
    console.log(`Event: ${eventName}`);
    console.log(`Data: ${JSON.stringify(data)}`);
  },
  sendErrorData(error, data) {
    // Capture error telemetry
    console.error(`Error: ${error}`);
    console.error(`Data: ${JSON.stringify(data)}`);
  },
});

function handleError(
  logger: vscode.TelemetryLogger,
  err: any,
  stream: vscode.ChatResponseStream
): void {
  // making the chat request might fail because
  // - model does not exist
  // - user consent not given
  // - quote limits exceeded
  logger.logError(err);

  if (err instanceof vscode.LanguageModelError) {
    console.log(err.message, err.code, err.cause);
  } else {
    // re-throw other errors so they show up in the UI
    throw err;
  }
}

export function deactivate() {}
