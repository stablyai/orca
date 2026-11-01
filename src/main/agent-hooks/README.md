# Agent status integrations

Orca learns what each agent is doing through two channels. Both write into the hook server's
status store.

| Channel                                                                                                    | How                                                                                                                                                                                       | What it carries                                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Managed integrations** (this folder)                                                                     | Per-agent hooks, plugins and extensions that POST to the loopback hook server. Installers are listed in `managed-agent-hook-registry.ts`; each agent's code lives in `src/main/<agent>/`. | State, prompt, tool name and input, assistant reply, provider session id (resume and native chat), model, subagents |
| **OSC 7501** (Program Status Protocol, [spec](https://www.superlogical.com/rex/docs/build/program-status)) | The agent writes its own status into the terminal stream. Orca reads it from PTY output and answers the protocol's `?` probe.                                                             | State, blocked `kind`, one free-text line (`msg`), child records                                                    |

**Precedence:** hooks win, and OSC 7501 fills in wherever they don't speak. That covers:

- hooks turned off,
- hooks not installed (a fresh SSH host, an agent run by hand),
- programs with no integration at all,
- hooks that went silent for 2 minutes on a state the program has since left. A finished turn is
  silent by design, so only new work takes it; an approval reported after it rides the facet.

The next hook event takes the pane back. The rule lives in
`server/program-status/hook-precedence.ts`; the parser and the mapping live in
`src/shared/program-status/`.

**Hybrid:** beside whichever producer owns the row's state, the program's OSC 7501 report rides
along as a facet (`programStatus`: progress, its own one-line message, and blocks such as sign-in).
It comes only from the OSC 7501 channel, lives in `server/program-status/facet-store.ts`, is
attached to rows at publish time, and never decides state. What each surface shows is decided by
one resolver, `src/shared/program-status/presentation.ts`.

## OSC 7501 support matrix

_Last updated: 2026-10-17._ Each "✅ live" row was checked by running the real CLI in a PTY whose
terminal answered queries the way Orca does.

**Columns:**

- **Probe:** whether the agent waits for the terminal to answer `OSC 7501 ; ?` before it sends
  anything (Orca answers).
- **Kinds:** which `blocked` reasons it names: `permission`, `question`, `auth`.
- **Children:** whether it reports subagents as child records.

### Agents that send OSC 7501

| Agent                  | Verified                                  | Probe                                      | States   | Kinds                | `msg` content                                                  | Children     | Orca integration | Use OSC 7501 for                                                              |
| ---------------------- | ----------------------------------------- | ------------------------------------------ | -------- | -------------------- | -------------------------------------------------------------- | ------------ | ---------------- | ----------------------------------------------------------------------------- |
| Claude Code (`claude`) | ✅ live, 2.1.302 (support since 2.1.295)  | required                                   | all five | all three            | task summary, "approve Write: …", "answer: Q? (A · B)", errors | ✅ subagents | hooks            | Fallback. Richest OSC 7501 of any harness, but no prompt and no session id. ¹ |
| Grok (`grok`)          | ✅ live, 1.0.60 (`program_status = auto`) | required (`on` forces it)                  | all five | yes                  | live phase ("Writing command…"), "Turn complete in 19s."       | ✅           | hooks            | Fallback                                                                      |
| pi (`pi`)              | ✅ live, 1.3.0                            | required (`PI_PROGRAM_STATUS=1` forces it) | all five | all three            | session name, dialog title, first line of an error             | —            | extension        | Fallback                                                                      |
| oh-my-pi (`omp`)       | ✅ live, 18.10.3                          | sends without asking                       | all five | permission, question | on `blocked`/`error` only                                      | —            | extension        | Fallback                                                                      |
| Codex (`codex`)        | ✅ live, 0.163.0                          | sends without asking                       | all five | none sent (0.163)    | none                                                           | —            | hooks            | Fallback; state only                                                          |

### Agents that don't send OSC 7501 yet

| Agent                                                                                  | Checked                             | Orca integration           |
| -------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------- |
| OpenCode (`opencode`, `opencode2`)                                                     | installed binary v2.0.16 and source | plugin                     |
| Kilocode (`kilo`)                                                                      | installed package and source        | —                          |
| Cursor (`cursor`)                                                                      | installed binary 2026.06.02         | hooks                      |
| Amp, Droid, Hermes, Muse, Devin, Kiro                                                  | installed binaries                  | hooks                      |
| Qoder (`qoder`)                                                                        | installed binary 1.1.65             | hooks                      |
| CodeBuddy (`codebuddy`)                                                                | installed package                   | hooks                      |
| Jcode (`jcode`)                                                                        | installed binary 0.95.0             | hooks                      |
| Qwen Code, Freebuff, DeepSeek (`dsh`)                                                  | source                              | hooks (qwen-code, dsh)     |
| Gemini, Antigravity, Copilot, Kimi, Command Code, ZCode, OpenClaude, Mimo, Prime Agent | not checked                         | hooks / plugin / extension |

¹ Claude Code stops putting its `⠂`/`✳` status glyph in the window title once Orca answers the
probe. So everything that read that glyph reads the program's activity instead while it reports:
the title trackers (`createAgentStatusTracker`, and `classifyPtyTitleStatus` in main) and the
Escape-interrupt check (`ClaudeTerminalInterruptTracker`). Activity ends when the shell prompt
returns or the terminal resets, even though a `done`/`error` record stays on screen, so a later
agent in the same pane is classified by its own titles again. Because answering changes what Claude
paints, a client answers for a remote Orca host only when that host advertises
`terminal.program-status.v1`.

## Could an agent drop its hook for OSC 7501?

Not today. OSC 7501 has no field for the prompt, tool input, assistant reply, model, or provider
session id. Native chat, resume, sidebar previews and notification text all need those. An agent
can move to OSC 7501 only once its OSC 7501 output, or another channel, carries the same data.

## Keeping this table current

When an agent ships OSC 7501 support, or changes what it reports:

1. Run it in a PTY whose terminal answers `OSC 7501 ; ?` and record the reports.
2. If its `app` id differs from Orca's agent id, add the mapping to `APP_TO_AGENT_TYPE` in
   `src/shared/program-status/agent-status-projector.ts` (examples: `claude-code` → `claude`,
   `grok-build` → `grok`). Otherwise hook precedence can't match its rows.
3. Update the row and the date above.
