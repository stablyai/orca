# Agent status via OSC 9999

Orca parses an OSC 9999 status sequence on every PTY, before the data reaches
xterm. Any process that prints one becomes a first-class Agent Dashboard
citizen: it gets a status card with state, prompt, and agent type — no agent
hook, no title heuristic, no recognised process name required.

Why this matters: the Agent Dashboard is otherwise blind to TUI tools. A card
needs a hook-reported agent or a title matching a known CLI in
`src/shared/agent-title-identity.ts`. Long-running terminal tools — build
loops, validation pipelines, agent harnesses — are invisible, and their users
conclude the dashboard is only for Orca-spawned agents. One `printf` fixes
that.

## Sequence shape

```
ESC ] 9999 ; <json> <terminator>
```

- Prefix: `ESC ] 9999 ;` (OSC 9999, `OSC_AGENT_STATUS_PREFIX` in
  `src/shared/agent-status-osc.ts`).
- Payload: a single JSON object (see [Fields](#fields)).
- Terminator: BEL (`\x07`, one byte) or ST (`ESC \`, two bytes). Either is
  accepted; the parser picks whichever comes first.

Example, from an ordinary shell in an Orca terminal:

```sh
printf '\033]9999;{"state":"working","agentType":"build-loop","prompt":"compiling release"}\007'
```

`orca worktree ps --json` then reports the pane as:

```json
{ "agentType": "build-loop", "state": "working", "prompt": "compiling release" }
```

Closing the tab removes the card cleanly.

## Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `state` | string | yes | One of `working`, `blocked`, `waiting`, `done`. Anything else rejects the whole payload. |
| `prompt` | string | no | Short human-readable description of current activity. Empty string when omitted. |
| `agentType` | string | no | Any non-empty string; well-known names (`claude`, `codex`, `opencode`, …) get matching icons, unknown strings render generically. Max 40 chars. |
| `model` | string | no | Model identifier, max 120 chars. |
| `toolName` | string | no | Max 60 chars. |
| `toolInput` | string | no | Max 160 chars. |
| `interactivePrompt` | string | no | Max 16 000 chars. |
| `lastAssistantMessage` | string | no | Max 8 000 chars. |
| `interrupted` | boolean | no | True when this `done` was a cancellation. |
| `sessionBoundary` | boolean | no | True when this `done` marks a session boundary, not a completed turn. |
| `subagents` | array | no | Live in-process child snapshots, rendered as indented rows. |

Unknown fields are ignored, so adding an optional field later is
forward-compatible (same rule as [remote wire compatibility](remote-wire-compatibility.md)
Rule 1). A malformed JSON body, an invalid `state`, or a non-string field type
rejects the whole payload — the sequence is stripped from the terminal data and
no status is reported.

The payload is validated by the same `parseAgentStatusPayload` used for
hook-reported status, so hook and OSC inputs follow identical field rules and
limits.

## States and dashboard behavior

- `working` — spinner card.
- `blocked` — card moves to **Needs You**: the dashboard's "this one is
  waiting on a human" signal, useful for tools that pause on input.
- `waiting` — pending state, card shown as waiting.
- `done` — completes the card (with `interrupted: true` when the run was
  cancelled).

`state: "blocked"` is exactly the signal long-running interactive tools need:
the pane is waiting on a person, not stuck.

## Parsing details

- Parsed in `pty-transport.ts` / `pty-connection.ts` before xterm, on every
  PTY, with no agent gate — hidden and mounted panes alike.
- The parser is stateful across chunks: a prefix or payload split across PTY
  data events (including a split terminator) is carried into the next chunk and
  still parsed correctly. `createAgentStatusOscProcessor` returns both the
  parsed payloads and the terminal data with the sequences stripped, so the
  sequences never render in the terminal.
- Sequences with no terminator yet are buffered; payloads buffered beyond
  `MAX_PENDING` (64 KiB) are discarded to bound memory.
- Payloads flow through the same `onAgentStatus` path as hook-reported status,
  so existing dashboard consumers (worktree list, session tabs, mobile
  projection) pick them up unchanged.

## Stability

The sequence is implemented and covered by tests (`src/shared/agent-status-osc.test.ts`),
but it is an internal contract, not a documented public API: there is no
promise that the JSON shape stays stable across Orca versions. If you depend on
it, keep the surface minimal (`state` + `prompt` + `agentType`) and treat
everything else as best-effort. A change that breaks the shape would go through
`parseAgentStatusPayload`, and per remote wire compatibility, optional-field
additions are safe while removals or required-field changes are breaking.
