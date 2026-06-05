# Agent Session Resume Evidence for Sleep/Wake

Date: June 5, 2026

Scope: issue [stablyai/orca#1796](https://github.com/stablyai/orca/issues/1796), current worktree code, installed agent CLIs on this machine, cloned open-source CLI repos under `/tmp/orca-agent-resume-research`, and official provider docs where available.

## Executive conclusion

Orca can implement one-click agent resume on wake, but it cannot use terminal PTY IDs, pane keys, tab IDs, or worktree IDs as the agent session ID. Those are Orca terminal identifiers. The required value is the provider's conversation/session/thread ID.

For several first-tier providers, the exact provider ID is available in hook payloads today, but Orca drops it during normalization:

- Claude: hook payloads include `session_id`; resume command is `claude --resume <session_id>`.
- Codex: hook runtime sends `session_id`; resume command is `codex resume <session_id>`.
- Gemini: hook payloads include `session_id`; resume command is `gemini --resume <session_id>`.
- Antigravity: hook payloads include `conversationId`; resume command is `agy --conversation <conversationId>`.
- OpenCode: Orca's managed plugin already reads OpenCode `sessionID`; resume command is `opencode --session <sessionID>`.
- Droid: hook payloads include `session_id`; resume command is `droid --resume <session_id>`.
- Grok: hook payloads include `sessionId`/`session_id`; resume command is `grok --resume <sessionId>`.

The current blocker is not primarily "how do we resume?" The exact resume action is to spawn a new agent process on wake in the same workspace/pane context using the provider-specific resume command. The blocker is that Orca's current hook event and status types have no durable provider-session field, so the ID is discarded before sleep.

## Current Orca behavior

Issue #1796 is accurate about current behavior. The issue says sleep loses agent type, session ID, last prompt, and resume command because `dropAgentStatusByWorktree` wipes rows before wake can offer resume.

Verified current code path:

- Sleep calls terminal shutdown with identifiers preserved, not provider conversation metadata. See `src/renderer/src/components/sidebar/sleep-worktree-flow.ts`.
- `shutdownWorktreeTerminals(worktreeId, { keepIdentifiers: true })` preserves terminal IDs/layout wake hints, then calls `dropAgentStatusByWorktree(worktreeId)`. See `src/renderer/src/store/slices/terminals.ts`.
- `agentStatusByPaneKey` is explicitly documented as "Real-time only - lives in renderer memory, not persisted to disk." See `src/renderer/src/store/slices/agent-status.ts`.
- `WorkspaceSessionState` persists terminal/browser/editor/SSH state, including terminal layouts and remote relay PTY IDs, but no sleeping-agent records. See `src/shared/types.ts`, `src/renderer/src/lib/workspace-session.ts`, and `src/shared/workspace-session-schema.ts`.
- `AgentStatusEntry` has `state`, `prompt`, timestamps, `agentType`, pane/tab/worktree attribution, tool previews, assistant preview, and orchestration context. It has no provider session ID or resume command field. See `src/shared/agent-status-types.ts`.

The existing sleep persistence is terminal-resume metadata. The feature needs provider-conversation-resume metadata.

## Hook pipeline gap

The current local and SSH hook wire shapes drop provider IDs:

- `AgentHookEventPayload` in `src/shared/agent-hook-listener.ts` includes pane/tab/worktree, prompt cache fields, hook event name, Claude tool/subagent IDs, and normalized `payload`. It has no provider session ID field.
- `AgentHookRelayEnvelope` in `src/shared/agent-hook-relay.ts` mirrors that normalized shape for SSH. Its comment states the relay normalizes before sending the envelope. Therefore remote/SSH events lose provider IDs at the relay boundary too unless the new field is added to the shared envelope.
- `ParsedAgentStatusPayload` in `src/shared/agent-status-types.ts` includes only status fields: `state`, `prompt`, `agentType`, `toolName`, `toolInput`, `lastAssistantMessage`, `interrupted`.

Implementation implication: provider-session metadata must be extracted before normalization completes and must be carried through both the local HTTP path and the SSH relay path.

## Installed CLI versions checked

These exact binaries were available on this machine:

| Agent | Version checked |
| --- | --- |
| Claude Code | `2.1.165` |
| Codex | `codex-cli 0.137.0` |
| Gemini | `0.44.0` |
| OpenCode | `1.15.13` |
| Cursor Agent | `2025.09.18-7ae6800` |
| Antigravity | `1.0.5` |
| Droid | `0.122.0` |
| Grok | `grok 0.2.22 (967574cb117) [stable]` |
| Pi | `0.72.1` |
| Amp, Copilot, Command Code, Hermes | Not installed locally |

## Provider matrix

Legend:

- `Exact supported`: exact resume command and exact ID source are both verified.
- `Resume verified, ID capture missing`: CLI can resume, but current Orca hook path does not expose a durable exact ID.
- `ID seen, resume not verified`: Orca/source exposes an ID, but no exact resume CLI command was verified.
- `Out of current hook scope`: Orca has no current hook source for this TUI agent.

| Agent | Resume command evidence | Exact ID source evidence | Current Orca support status |
| --- | --- | --- | --- |
| Claude | `claude --resume <session_id>` verified by local `claude --help` and Anthropic CLI docs. | Claude hook docs show hook input includes `session_id` and `transcript_path`; current Orca normalizer drops `session_id`. | Exact supported after adding provider-session metadata extraction. |
| Codex | `codex resume <session_id>` verified by local help and cloned Codex source `codex-rs/utils/cli/src/resume_command.rs`. | Cloned Codex source `codex-rs/core/src/hook_runtime.rs` sends `session_id` on `SessionStart`, `PreToolUse`, `PermissionRequest`, and `PostToolUse` hook requests. | Exact supported after extraction. |
| Gemini | `gemini --resume <session_id>` verified by local help and Gemini docs. | Gemini hooks reference says all hooks receive `session_id` and `transcript_path`. | Exact supported after extraction. |
| Antigravity | `agy --conversation <uuid>` verified by local help and Antigravity docs. | Antigravity hook docs list `conversationId` as the active conversation UUID. | Exact supported after extraction. |
| OpenCode | `opencode --session <sessionID>` verified by local help, official docs, and cloned OpenCode TUI source. | Orca's OpenCode plugin already reads `event.properties?.sessionID` before posting. | Exact supported after preserving `sessionID`. |
| Droid | `droid --resume <sessionId>` verified by local help and Factory CLI docs. | Factory hooks reference includes `session_id`; Orca installs Droid hooks and already subscribes to `SessionStart`. | Exact supported after extraction. |
| Grok | `grok --resume <SESSION_ID>` verified by local help. | Orca already reads `sessionId`/`session_id` in `getGrokChatHistoryPath`, but only to locate chat history. | Exact supported after preserving that same ID. |
| Cursor | `cursor-agent --resume <chatId>` and `cursor-agent resume` verified by local help and Cursor docs. | Current Orca Cursor hook install deliberately omits `sessionStart`/`sessionEnd`; the subscribed event set does not currently prove a chat ID source. `cursor-agent create-chat` was locally verified to return a UUID, but preallocation for Orca launches still needs an end-to-end test before relying on it. | Resume verified, ID capture missing. |
| Pi | `pi --session <path|id>`, `pi --resume`, and `pi --continue` verified by local help and Pi docs. | Orca's bundled Pi/OMP extension posts status events but does not include session file path, session UUID, or session name in the status payload. | Resume verified, ID capture missing. |
| OMP | Same launch family as Pi in Orca. | Orca reuses Pi extension API shape and does not include exact session pointer. | Resume verified by inheritance only from Pi-like CLI contract; exact OMP ID capture missing. |
| Amp | Orca's managed plugin posts `threadId: event.thread.id`. | Amp is not installed locally, and no exact Amp CLI resume command was verified in this investigation. | ID seen, resume not verified. |
| Hermes | Orca's managed Hermes plugin selects `session_id` for session/LLM/tool events. | Hermes is not installed locally, and no exact Hermes CLI resume command was verified in this investigation. | ID seen, resume not verified. |
| Copilot | Orca installs broad Copilot hooks. | Local Copilot CLI not installed; no exact resume command or session ID contract was verified. | Not supported for exact resume yet. |
| Command Code | Orca installs hooks for `PreToolUse`, `PostToolUse`, and `Stop`. | Local Command Code CLI not installed; no exact resume command or session ID contract was verified. | Not supported for exact resume yet. |
| openclaude, autohand, aider, goose, kilo, kiro, crush, aug, cline, codebuff, continue, kimi, mistral-vibe, qwen-code, rovo, openclaw | Not investigated to exact-resume standard. | Not in `HOOK_SOURCE_BY_PATHNAME` today. | Out of current hook scope. |

## Exact resume behavior by provider

### Claude

Verified:

- Local `claude --help` shows `--continue`, `--resume [value]`, `--session-id <uuid>`, `--fork-session`, and `--no-session-persistence`.
- Anthropic CLI docs show `claude -r "<session-id>" "query"` and document `--resume` as resuming a specific session by ID.
- Claude hooks docs show hook input includes `session_id` and `transcript_path`.

Resume command:

```sh
claude --resume <session_id>
```

If Orca stores `lastPromptSummary` separately, it should not pass that summary as a new user prompt by default. The one-click resume action should reopen the prior conversation. Auto-submitting a summary would create a new turn.

### Codex

Verified:

- Local `codex resume --help` accepts `[SESSION_ID] [PROMPT]`, where the session target is a UUID or session name.
- Cloned Codex source `codex-rs/utils/cli/src/resume_command.rs` formats `codex resume <thread_id>`.
- Cloned Codex source `codex-rs/core/src/hook_runtime.rs` sends `session_id` on hook requests.
- Cloned Codex source has tests asserting resumed root sessions use the thread ID as session ID.

Resume command:

```sh
codex resume <session_id>
```

Avoid `codex resume --last` for this feature when an exact ID is available. `--last` can resume the wrong conversation if another Codex session ran after the slept workspace.

### Gemini

Verified:

- Local `gemini --help` shows `--resume`, `--session-id`, `--session-file`, and `--list-sessions`.
- Gemini official hooks reference states all hook input includes `session_id` and `transcript_path`.
- Gemini official configuration docs describe `--resume [session_id]` and state that a UUID can be supplied.

Resume command:

```sh
gemini --resume <session_id>
```

### Antigravity

Verified:

- Local `agy --help` shows `--continue` and `--conversation`.
- Antigravity conversation docs show `agy --continue` for most recent and `agy --conversation <uuid>` for a specific session.
- Antigravity hooks docs define common hook input `conversationId`.

Resume command:

```sh
agy --conversation <conversationId>
```

### OpenCode

Verified:

- Local `opencode --help` shows `--continue` and `--session`.
- Official OpenCode docs list `--session` as the session ID to continue.
- Cloned OpenCode source `packages/opencode/src/cli/cmd/tui/thread.ts` defines `--session` and passes it into TUI args as `sessionID`.
- Cloned OpenCode source `validate-session.ts` validates the supplied session ID through the OpenCode client.
- Orca's managed OpenCode plugin reads `event.properties?.sessionID`.

Resume command:

```sh
opencode --session <sessionID>
```

### Droid

Verified:

- Local `droid --help` shows `--resume [sessionId]`, `--fork <sessionId>`, and `--cwd`.
- Factory CLI docs list resume behavior and `droid exec -s <id>` for exec mode.
- Factory hooks reference says `SessionStart` has a `resume` matcher and hook input includes `session_id`.

Resume command:

```sh
droid --resume <session_id>
```

### Grok

Verified:

- Local `grok --help` shows `--resume [<SESSION_ID>]`, `--continue`, `--cwd`, and `--restore-code`.
- Orca already reads `sessionId`/`session_id` in `getGrokChatHistoryPath`.

Resume command:

```sh
grok --resume <sessionId>
```

### Cursor

Verified:

- Local `cursor-agent --help` shows `--resume [chatId]`.
- Cursor docs show listing prior chats with `cursor-agent ls`, resuming latest with `cursor-agent resume`, and resuming a specific conversation with `cursor-agent --resume="chat-id-here"`.
- Local help shows `cursor-agent create-chat` creates an empty chat and returns its ID.
- Running `cursor-agent create-chat` locally returned UUID `1fff2e62-9dd0-4cf3-9d8c-3569fea0aff7`, proving the command can preallocate a chat ID without an initial prompt.

Not verified:

- Current Orca Cursor hook install subscribes to `beforeSubmitPrompt`, `stop`, tool events, approval events, and `afterAgentResponse`, but intentionally does not subscribe to `sessionStart`/`sessionEnd`.
- I did not verify a current subscribed Cursor hook payload containing `chatId`.
- I did not run `cursor-agent --resume <chatId> <prompt>` because that would start a real agent turn and may make workspace changes.

Conclusion: exact Cursor resume is CLI-supported, but Orca currently needs either a verified hook payload chat ID or a launch preallocation strategy that is tested end to end.

### Pi and OMP

Verified:

- Local `pi --help` shows `--continue`, `--resume`, `--session <path|id>`, `--fork <path|id>`, `--session-dir`, and `--no-session`.
- Pi docs state `/resume` opens a picker and `pi -r` opens the same picker at startup.
- Orca's Pi/OMP extension posts status events from Pi's extension API, but the status events do not include session path, UUID, or session name.

Resume command:

```sh
pi --session <path-or-id>
```

Conclusion: exact Pi resume is CLI-supported, but current Orca capture is missing the exact pointer.

## What Orca should store

Store a durable record per sleeping agent pane, not per worktree only:

```ts
type SleepingAgentSessionRecord = {
  id: string
  worktreeId: string
  tabId?: string
  paneKey: string
  connectionId: string | null
  agentType: TuiAgent
  providerSession: {
    kind: 'session_id' | 'conversation_id' | 'thread_id' | 'chat_id' | 'path'
    value: string
  }
  resumeCommand: {
    argv: string[]
    cwd?: string
  }
  lastPrompt: string
  lastAssistantMessage?: string
  capturedAt: number
  retentionUntil?: number | null
}
```

Important constraints:

- `resumeCommand.argv` should be structured argv, not a shell string. This avoids cross-platform quoting bugs.
- Do not persist a terminal PTY ID as `providerSession.value`.
- For SSH, `cwd` and the command execute on the remote host. The provider session ID also belongs to the remote CLI's session store.
- For local workspaces, execute locally in the worktree path.
- For auto-resume, launch exactly one process per sleeping agent record and guard against double-click/duplicate wake races.

## Provider extraction map

This is the extraction map that is supported by the evidence above:

| Hook source | Provider session field(s) to extract | Resume argv |
| --- | --- | --- |
| `claude` | `session_id` | `['claude', '--resume', id]` |
| `codex` | `session_id` | `['codex', 'resume', id]` |
| `gemini` | `session_id` | `['gemini', '--resume', id]` |
| `antigravity` | `conversationId` | `['agy', '--conversation', id]` |
| `opencode` | `sessionID` | `['opencode', '--session', id]` |
| `droid` | `session_id` | `['droid', '--resume', id]` |
| `grok` | `sessionId`, fallback `session_id` | `['grok', '--resume', id]` |
| `amp` | `threadId` | not enabled until Amp resume command is verified |
| `hermes` | `session_id` | not enabled until Hermes resume command is verified |

## Required implementation shape

1. Add a provider-session metadata type to shared hook types.
2. Extract provider session evidence in `parseAgentHookEvent` from raw `hookPayloadRecord` before normalizing to `ParsedAgentStatusPayload`.
3. Carry it in `AgentHookEventPayload`.
4. Carry it in `AgentHookRelayEnvelope` so SSH does not lose it.
5. Store latest provider-session evidence by pane key alongside live agent status.
6. On sleep, snapshot the live agent status plus latest provider-session evidence before `dropAgentStatusByWorktree`.
7. Persist sleeping-agent records in `WorkspaceSessionState` and schema.
8. On wake, render sleeping resumable rows separately from active rows and launch the provider-specific structured argv when the user resumes.
9. Clear records on explicit worktree removal, not on sleep.
10. If the provider session no longer exists, let the provider CLI fail and surface that failure without deleting the record until the user dismisses it.

## Open questions that remain genuinely unverified

- Cursor: whether any currently subscribed Cursor hook payload carries `chatId`. If not, the only plausible exact strategy is preallocating a chat with `cursor-agent create-chat` at launch and starting/resuming that known chat. That needs an end-to-end test before productizing.
- Pi/OMP: whether the extension API can expose the current session file/path/UUID. Current Orca extension does not forward it.
- Amp: whether the Amp CLI has an exact thread resume command matching `threadId`.
- Hermes: whether Hermes has an exact session resume CLI command matching `session_id`.
- Copilot and Command Code: exact resume command and exact hook session field were not verified because the CLIs were not installed locally and no sufficient primary docs/source were found during this pass.
- Non-hook TUI agents: no exact support should be promised until Orca adds a hook/metadata capture path for each.

## Sources

Local Orca source:

- `src/shared/agent-hook-listener.ts`
- `src/shared/agent-hook-relay.ts`
- `src/shared/agent-status-types.ts`
- `src/shared/types.ts`
- `src/shared/tui-agent-config.ts`
- `src/renderer/src/store/slices/terminals.ts`
- `src/renderer/src/store/slices/agent-status.ts`
- `src/renderer/src/lib/workspace-session.ts`
- `src/shared/workspace-session-schema.ts`
- `src/main/opencode/hook-service.ts`
- `src/main/amp/hook-service.ts`
- `src/main/hermes/hook-service.ts`
- `src/main/pi/agent-status-extension-source.ts`
- `src/main/cursor/hook-service.ts`

Cloned source:

- `/tmp/orca-agent-resume-research/codex`
- `/tmp/orca-agent-resume-research/gemini-cli`
- `/tmp/orca-agent-resume-research/opencode`

Official docs:

- GitHub issue: https://github.com/stablyai/orca/issues/1796
- Claude CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-usage
- Claude hooks reference: https://code.claude.com/docs/en/hooks
- Gemini hooks reference: https://geminicli.com/docs/hooks/reference/
- Cursor CLI parameters: https://docs.cursor.com/en/cli/reference/parameters
- Cursor CLI usage: https://docs.cursor.com/en/cli/using
- OpenCode CLI docs: https://opencode.ai/docs/cli/
- Antigravity conversation docs: https://antigravity.google/docs/cli-conversations
- Antigravity hooks docs: https://www.antigravity.google/docs/hooks
- Factory Droid hooks reference: https://docs.factory.ai/cli/configuration/hooks-reference
- Factory Droid CLI reference: https://docs.factory.ai/cli/configuration/cli-reference
- Pi docs: https://pi.dev/docs/latest/tree
