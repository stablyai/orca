# Crash recovery of terminal agent conversations

## Persistence ownership

| State                                                 | Authority                                                  | Restart behavior                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Workspace, tabs, pane IDs, titles and resume locators | Profile workspace-session partition for the execution host | Rehydrate the saved layout and resume the exact provider session; folder workspaces use the same ownership rules. |
| PTY and in-flight execution                           | Terminal daemon on the execution host                      | Reattach only while the process survives. A host reboot cannot preserve process memory.                           |
| Terminal agent prompt, reply preview and turn outcome | Agent-hook `last-status.db`                                | Restore committed rows independently of quit; unconfirmed work requires host liveness reconciliation.             |
| Full provider conversation                            | Provider history / rollout                                 | Open through the saved provider session ID; a resume locator does not contain the transcript.                     |
| Native chat turns and outcomes                        | Agent-session journal                                      | Existing journal recovery and ownership adjudication apply; hook restart caches exclude structured sessions.      |

Completed resume records intentionally omit turn text. They locate the conversation; the hook status cache owns terminal completion previews. No second transcript store is needed.

## Reproduced failure paths

1. Hook status row keys contain a NUL separator (`entry\0<pane>`). Native `node:sqlite` TEXT reads can truncate the key at NUL. Startup then cannot assemble the stored pane rows even though their SQLite bytes remain. Read keys as BLOBs and decode UTF-8 without changing the schema or existing keys.
2. Routine hook saves are throttled. Prompt changes, completion facts and late final previews now bypass the routine checkpoint delay while retaining lock retry/backoff and changed-row transactions. This recovery cache uses SQLite FULL synchronous commits so a committed turn does not depend on a later WAL checkpoint to survive power loss; other caches retain their existing mode.
3. An empty same-session Codex `SessionStart` replaced the committed prompt, preview and outcome with idle session-boundary state. Restore the saved turn only for the exact session and host/workspace. Live compaction, explicit prompts and different sessions retain their existing transition rules. Opening a conversation does not open another user turn or mint another completion.
4. Dead-PTY reconciliation hid restored unfinished work behind provider-only identity. A proven missing process now leaves a visible interrupted conversation. If idle resume wins the startup race before liveness is known, retain the prompt with an unconfirmed outcome instead of reporting success. Dismissed provider-only rows stay hidden.

The cache retains its existing age policy. These changes cannot recover writes rejected by a full disk, metadata already overwritten by an older runtime, or execution that existed only in process memory. They do not replay prompts or tools, scan every provider transcript on startup, or bypass provider routing failures.

## Isolated verification

`server-crash-turn-recovery.test.ts` starts another hook owner over a temporary committed database without calling the previous owner's quit path. It exercises completed turns, repeated resume, both startup orders for unfinished work, SSH folder workspaces and newer-work/host boundaries. No real provider process or user profile is used.

`server-status-persist-throttle.test.ts` reads the committed completion without stopping the server. `keyed-json-row-cache.test.ts` reopens and updates distinct NUL-containing keys using the real SQLite implementation. Each new regression fails when its owning production change is reverted.

Targeted tests can run through the repository's normal `pnpm test ... --maxWorkers=2` entry. If the bundled config loader stalls locally, the same repository config can run under native Node with:

```sh
ORCA_BACKGROUND_LAUNCH=1 ORCA_VITEST_ISOLATE_EVERY_FILE=1 node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts --configLoader runner src/main/agent-hooks/server/testing/persistence src/main/agent-hooks/server/testing/providers/codex/server-codex-session-start.test.ts src/main/agent-hooks/server/testing/reconciliation/ended-process-reconciliation.test.ts src/main/sqlite/row-cache/keyed-json-row-cache.test.ts --maxWorkers=2
```

## Hidden Electron acceptance

An isolated macOS Electron profile was initialized with a committed workspace layout. Synthetic Codex prompt/Stop hooks then produced a rendered completion through the real hook endpoint. After observing its committed SQLite row (without a quit-time flush), the owned main process was killed with SIGKILL and relaunched over the same profile. The rendered completion, provider session ID, prompt, reply preview and completion timestamp survived unchanged. The restored renderer entry had an array-valued `stateHistory` and the sidebar rendered without an error boundary. Before/after screenshots were captured through Playwright CDP; no test window was shown.

This validates an application crash over already-committed layout and turn facts. It does not simulate physical power loss or restart the developer’s application. Proven PTY loss and resume-before-liveness startup ordering are covered by the isolated hook-server regressions.
