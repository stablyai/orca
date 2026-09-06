# Chrome DevTools for agents with shell access

Any Orca agent that can execute a local command can access Chrome DevTools through the CLI bridge, including agents without a native MCP client such as Aider. This does not add native MCP support to the agent. Agents whose policies disable shell execution need that capability enabled by their user.

The bridge uses the official `chrome-devtools-mcp` package over stdio. Run it on the same host as Chrome. It rejects remote Orca routing flags and forwarded execution context; a remote shell cannot auto-connect to the desktop on your local computer. The commands also work outside a Git repository, including folder workspaces.

## Prerequisites

- Install Node.js and `npx` on the execution host. The first invocation can download `chrome-devtools-mcp@latest` through `npx`.
- Open a supported Chrome version (144 or newer), enable remote debugging at `chrome://inspect/#remote-debugging`, and accept Chrome's connection prompt.
- Keep access to sensitive browser data and page-changing actions within the user's instructions.

The bridge supplies `--autoConnect`, `--no-usage-statistics`, and `--no-performance-crux`. It does not open Chrome, change debugging settings, or grant itself browser access. MCP initialization and each request have a 120-second timeout. Closing the bridge disconnects the MCP server without closing the user's Chrome.

## Discover and call tools

```sh
orca chrome-devtools tools --json
orca chrome-devtools call --tool list_pages --json
```

`tools` returns complete upstream input schemas. `call` accepts arguments from a JSON file, avoiding shell-specific escaping:

```sh
orca chrome-devtools call --tool evaluate_script --arguments-file arguments.json --json
```

For example, `arguments.json` can contain the following; replace `pageId` with an actual ID returned by `list_pages`:

```json
{ "pageId": 1, "function": "() => ({title: document.title, url: location.href})" }
```

The output preserves all MCP content blocks, including images and embedded resources. A tool result with `isError: true` is printed intact and produces a nonzero exit code. Protocol/startup failures also fail the command. Neither discovery alone nor a configured server proves that Chrome has authorized a connection; verify with `list_pages`.

Each `call` starts a fresh MCP session. Selected pages, snapshot UIDs, network request IDs, and other session state are not shared between separate invocations. Use a persistent session for workflows that depend on those values.

For Aider, a read-only invocation is:

```text
/run orca chrome-devtools call --tool list_pages --json
```

Aider asks whether to add the command output to its conversation using its normal confirmation behavior. Other agents can run the same CLI through their shell tool. Restart existing agent sessions if installing Orca changed their executable search path.

## Preserve browser session state

```sh
orca chrome-devtools session
```

The process reads JSONL from stdin and emits one compact JSON response per request. `--json` is accepted; session output is always JSONL. Keep the process and stdin open through the agent's terminal/process tool. Send requests sequentially, inspect each response, and then send the next request. Close stdin to disconnect.

Requests:

```json
{"id":"discover","type":"tools"}
{"id":"pages","type":"call","tool":"list_pages","arguments":{}}
```

Then, using an actual page ID returned by `list_pages`:

```json
{"id":"select","type":"call","tool":"select_page","arguments":{"pageId":1}}
{"id":"snapshot","type":"call","tool":"take_snapshot","arguments":{"pageId":1}}
```

Only subsequent calls in this same process can use the returned snapshot UIDs. Do not copy the example page ID without checking the actual response. Consult `tools` for the current schema before performing another operation.

Responses preserve the supplied string or numeric ID:

```json
{ "id": "pages", "ok": true, "result": { "content": [{ "type": "text", "text": "..." }] } }
```

Malformed requests produce an error response without invoking a tool. Tool errors retain their MCP result and set `ok: false`. A protocol error or request timeout ends the session before processing further requests; a timeout does not prove that a page action was cancelled. Any failed response results in a nonzero process exit code. SIGINT/SIGTERM and stdin closure disconnect the MCP process.

Native client configuration remains available through [`orca agent chrome-devtools setup`](chrome-devtools-mcp.md). Use the native client when its tools and persistent MCP sessions are already available; the CLI bridge supplies an additional route for shell-capable agents.
