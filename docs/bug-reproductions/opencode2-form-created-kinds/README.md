# OpenCode 2 `form.created` is not always a question (#22371)

OpenCode 2 has one form primitive and several producers. Orca's setup bridge mapped every
`form.created` to `question.asked`, which is Orca's un-evictable "the pane owner must answer
this" blocker — including forms owned by a sentinel that is not a session.

Captured against the shipped `opencode v2.0.12` binary on macOS, driving the real TUI in a PTY
against a real `opencode serve` instance and reading the server's `/api/event` SSE stream.

## The discriminator: `form.sessionID`, not `form.metadata.kind`

`Form.Info` is `{ id, sessionID, title, metadata?, fields }`. Every `Form.ask` call site in the
v2.0.12 bundle (still exactly five on `v2.0.15`, in `tool/plugin/question.ts`,
`tool/plugin/websearch.ts` and `mcp/index.ts`):

| `metadata.kind`      | Form title                                    | `sessionID` | Blocks the pane owner    |
| -------------------- | --------------------------------------------- | ----------- | ------------------------ |
| `question`           | `Questions`                                   | the session | yes — the `question` tool |
| `websearch.provider` | `Web Search` / `Choose a web search provider` | the session | yes — the turn is stalled |
| `mcp-elicitation`    | `<server> is requesting input`                | `"global"`  | no — see below            |

`metadata.kind` looks like the discriminator but cannot be one. In `packages/schema/src/form.ts`
on `v2.0.15`, `Metadata` is `Schema.Record(Schema.String, Schema.Unknown)` and line 130 declares
`metadata: Metadata.pipe(optional)` — so `metadata` may be absent entirely and `kind` is a
convention no producer is obliged to stamp. The public `POST /api/session/:sessionID/form`
endpoint (`packages/protocol/src/groups/session.ts:809`, payload at ~147) lets any client raise a
genuinely blocking form on a real session with no metadata at all. Keying on
`metadata.kind === "question"` therefore drops real blockers silently.

What actually differs is the owner. `mcp-elicitation` passes `GLOBAL_ELICITATION_SESSION_ID`
(`"global"`, `packages/core/src/mcp/index.ts:82`), which is not a session, so a blocker minted for
it can never be retired by that session going idle — only by an exact `form.replied` /
`form.cancelled`. `websearch.provider` passes the real `context.sessionID`, so session idle retires
it normally, and while it is pending the agent genuinely is waiting on the user.

So Orca blocks on every session-owned form and drops only the non-session sentinel. Upstream notes
in `form.ts:122-129` that `"global"` is temporary and elicitations will get real session ids; when
that lands the exclusion stops matching and Orca starts blocking on them correctly.

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
