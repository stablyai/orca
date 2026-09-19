# OpenCode in-flight tool readout follow-up

Scope note for a future PR. Neither #21322 (v2 `setup()` loader fix) nor
#20410 (v2 event compat) bridges tool-call events, so opencode panes have no
in-flight-tool readout. Reviewer observation (oliver-mee, 2026-09-18 on
#21322): Claude/Codex rows show `Running <Tool>: <input>`; opencode rows do
not.

## What the siblings do

- Claude registers `PreToolUse` for the live readout
  (`src/main/claude/hook-settings.ts:77`).
- Codex documents `Pre/PostToolUse` as the readout feed
  (`src/main/codex/codex-hook-definition.ts:16`).
- Hooks carry `tool_name` + `tool_input`; normalization extracts
  `payload.toolName` / `payload.toolInput` with `state=working`
  (`src/main/agent-hooks/server-codex-normalization.test.ts:146`,
  `src/main/agent-hooks/server-claude-normalization.test.ts:33`).
- Renderer shows `toolName: toolInput` only for `working`/`waiting`
  (`src/renderer/src/lib/agent-row-tool-preview.ts:12`), string
  `Running {{toolName}} {{preview}}`. `PermissionRequest` reuses the same
  fields with `state=waiting`.
- Preview extraction is already generic
  (`src/shared/agent-hook-listener/tool-input-preview.ts:3`): `Bash/bash`,
  `Read/read`, `Edit/edit`, `Glob/glob`, `Grep/grep`, `exec_command`, plus a
  fallback key list. No renderer change needed.

## What opencode does today

- Plugin posts `SessionBusy`/`SessionIdle`, `SessionStart`, text-only
  `MessagePart {role, text}`, `PermissionRequest`/`AskUserQuestion`
  (`src/main/agent-hooks/server-opencode-normalization.test.ts:29`).
- Factory drops non-text parts (`src/main/opencode/status-plugin-factory-source.ts:107`:
  `part.type !== "text"` returns early). Tool parts are only inspected to clear
  `question` attention (`src/main/opencode/status-plugin-ownership-source.ts:30`).
- Unknown opencode event names normalize to null
  (`src/main/agent-hooks/server-opencode-normalization.test.ts:86`), so a tool
  event posted today would be discarded at the listener.

## The missing source

- v1: `message.part.updated` with `part.type === "tool"` (`part.tool` = name,
  `part.state.status`/`input` = lifecycle + args).
- v2: `session.tool.*` family, exact names and `data` envelope unverified.
  Do not trust the compiled `.d.ts` here: `session.created` (`data.id` vs
  `data.sessionID`) and turn boundaries (`session.status` vs
  `session.execution.*`) both required live captures to get right. Reuse the
  instrumented-adapter probe against a real 2.x turn containing a `bash` and a
  `read` before pinning shapes.

## Suggested shape of the future PR

1. Plugin (`status-plugin-v2-event-source` / `status-plugin-v2-setup-source`
   plus v1 factory path): map tool-start to a `tool_name`/`tool_input` POST
   (PreToolUse equivalent, `state=working`); let existing busy/idle own turn
   boundaries. Exclude the `question` tool from the readout path; permission
   tools stay on the `waiting` path.
2. Listener: accept the tool event for source `opencode` in the shared
   normalization dispatch so `toolName`/`toolInput` populate like the
   siblings. Add characterization tests mirroring the Claude/Codex ones.
3. Contract tests: tool-start posts readout fields; tool-done yields to
   idle; child-session tools roll up without synthesizing `SessionStart`.
4. Validate with the assembled generated module plus one live 2.x turn.

Independent blocker, not a prerequisite: #21359 (shared v2 server freezes
pane identity) misattributes which dot lights up, but the tool line itself
works the same once posted.
