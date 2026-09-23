# OpenCode 2 `form.created` is not always a question (#22371)

OpenCode 2 has one form primitive and several producers. Orca's setup bridge mapped every
`form.created` to `question.asked`, which is Orca's un-evictable "the pane owner must answer
this" blocker. Only one producer is an agent-initiated question.

Captured against the shipped `opencode v2.0.12` binary on macOS, driving the real TUI in a PTY
against a real `opencode serve` instance and reading the server's `/api/event` SSE stream.

## The discriminator: `form.metadata.kind`

`Form.Info` is `{ id, sessionID, title, metadata?, fields }`; `metadata` is an open record that
each producer stamps. Every `Form.ask` call site in the v2.0.12 bundle:

| `metadata.kind`      | Form title                                    | `sessionID` | Agent-initiated question  |
| -------------------- | --------------------------------------------- | ----------- | ------------------------- |
| `question`           | `Questions`                                   | the session | yes — the `question` tool |
| `websearch.provider` | `Web Search` / `Choose a web search provider` | the session | no — a provider picker    |
| `mcp-elicitation`    | `<server> is requesting input`                | `"global"`  | no — an MCP server prompt |

`mcp-elicitation` is the worst shape for Orca: `"global"` is not a session, so the blocker it
mints can never be retired by that session going idle — only by an exact `form.replied` /
`form.cancelled` for the same form id.

`form-created-question.json` and `form-replied-question.json` are the live capture of the
`question` tool's form being raised and answered. Note `metadata.tool` is `{ messageID, id }`,
not the `{ messageID, callID }` that Orca's `clearQuestionForToolPart` matches on, and OpenCode 2
never emits `message.part.updated` at all — so that retirement path is dead for OpenCode 2 and
`form.replied` / `form.cancelled` is the only reply-side retirement it has.

## The reported menu does not raise a form

`subagent-panel-screen.txt` is the rendered PTY screen from the reported surface — the
`Subagents / Shell / Terminals` activity dock, opened over a session with three subagents.
The whole time that dock was opened, paged and dismissed, the server's `/api/event` stream
carried nothing but `server.connected`, heartbeats, and unrelated `skill.updated` filewatcher
noise from another checkout. Same result for the `shift+tab` agent picker and the `ctrl+p`
command palette. The TUI's pickers are local Solid components; they never call `Form.ask`, so
they produce no server event of any kind and cannot be the thing Orca saw.

So this capture proves the mapping was wrong and which field fixes it; it does not reproduce
the exact frame in the issue screenshot.

## Reproduce

```sh
opencode serve --hostname 127.0.0.1 --port 47391     # OPENCODE_SERVER_PASSWORD=<pw>
curl -s -u opencode:<pw> -N http://127.0.0.1:47391/api/event   # tee this
opencode --server http://127.0.0.1:47391 --session <sid>       # drive in a PTY
```

Ask the agent to call its `question` tool for the `question` shape. For the picker and MCP
shapes, `POST /api/session/<sid>/form` with the `metadata.kind` from the table — that is the
same publish path the internal producers use, and it is what the plugin-level check was
verified against.
