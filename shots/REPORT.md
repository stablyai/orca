# Sticky workers dock: rebase + gates + shots (M4 Air)

- Branch: AmethystLiang/sticky-workers-design (stablyai/orca)
- Old head: 3927ce3bdca4 → **new head: 9e12bb2fea083d30b4b4fdd8ad969ae3b9beb32b** (pushed with --force-with-lease)
- **Main: 43d36831ba2e24ec1f7986f0acafdd28e25c7814** (rebased three times as main moved: b51f439 → 82d219f → 43d3683)
- Worktree on this machine: (local worktree on the M4 Air)
- No PR opened.

## Conflicts resolved

Main's #46786 ("test: cut the suite to the tests that guard real invariants") deleted several files that the branch had edited. Main's deletions were kept in every case:
- `use-structured-native-chat-subagents.performance.test.tsx` and `use-native-chat-crew.performance.test.tsx`: the branch's commit 2197adfe1f9 only touched these two files, so it became empty and was skipped.
- `structured-agent-session-newer-content-host.test.ts`, `orca-runtime-test-scenario-builders.spec.ts`, `crew-read-model.test.ts`, `runtime-orchestration-sender-names.test.ts`, `orchestration-worker-mode-opacity.test.ts`: the branch's changes to these were 1-line fixture fields, plus a 17/14-line update to the newer-content-host test.

Content conflicts:
- `src/renderer/src/i18n/locales/en.json`: kept main's `native-chat.dock.label` and the branch's `workerDock` block side by side.
- `NativeChatComposerPane.tsx`: took main's `NativeChatComposerRoomProvider` structure and re-applied the branch's `dock={dock}` and `{...nativeChatDictationFieldProps(dictation)}`.
- `NativeChatStructuredSession.tsx`: took main's `NativeChatDockTranscript` and `NativeChatDock` layout. In main's ordering, `{subagents.strip}` plus `NativeChatPartyWorkerApprovalStack` are replaced by `{composerShown ? null : subagents.dock}`, and the composer gets `dock={subagents.dock}`.
- `config/main-blocking-helper-baseline.txt`: kept main's peer-mail rows (`paired-server-changes.ts`, `peer-questions-out.ts`) and dropped the branch's stale `peer-mail-relay.ts` row, which main had moved. The dock rows were added in path order.

Post-rebase fixes (commit 630c8bf6383):
- `NativeChatApprovalCard.tsx` hit max-lines (413 > 400) once main's growth and the dock's `placement: 'dock'` were combined. The card's detail-clamp `useLayoutEffect` moved unchanged into `prompts/use-native-chat-approval-detail-clamp.ts`.
- There was an import cycle between `worker-dock-activity.ts` and `worker-dock-read.ts`. Activity now imports `workerDockSession` from `./worker-dock-source`, the module that defines it, instead of through `worker-dock-read`'s re-export.
- **Removed the e2e capture harness**: `tests/e2e/agents/native-chat/sticky-workers-capture.spec.ts` plus its 4 `sticky-workers-*.test-fixture.ts` files, and the 16-line `sticky-roster/mixed` addition to `tests/e2e/fixtures/structured-claude-stub.cjs`. It imported `../session-fixtures/structured-claude-stub`, which #46786 deleted, so it failed the e2e typecheck ratchet. It was a measurement harness, not a golden journey. **Reviewer decision point:** restore it from 3927ce3 if wanted, but that also means bringing back the deleted stub.

Commit 9e12bb2fea0 sets the narrow fixtures to 390 px and adds `botHomeChatNarrowFolded`.

## Gates (final head unless noted)

| Gate | Result |
|---|---|
| `pnpm typecheck` | PASS (exit 0, 0 TS errors) |
| `pnpm lint` (full, 49 steps) | PASS for the branch. On the final head, 47/49 passed outright. The 2 failures (oxlint, check:code-quality:changed) were only my untracked ad hoc harness files under shots/; after moving them out, both steps re-ran green. On the first rebased head, lint failed on the 3 branch issues fixed above, plus main's own `mobile/src/bots/MobileBotSettingsTab.tsx` max-lines (401), which main has since fixed. |
| Focused dock tests (9 files: dock/*.test.ts, worker-dock-methods, NativeChatBackgroundTasksStatus, WorkerDockRow, worker-dock-feed, worker-dock-scroll-anchor, structured-session-background-tasks-view) | PASS 26/26 |
| Recovery test `structured-agent-session-newer-content-host.test.ts` | **Deleted on main by #46786**, so it no longer exists in the tree. I ran the branch's copy ad hoc against the rebased code, temporarily restoring its two deleted fixtures (`structured-agent-session-host.test-fixture.ts`, `...-recovery-capsule.test-fixture.ts`) from 3927ce3: PASS 1/1 in 13.3 s, a real pass and not a timeout. All three files were removed again and nothing was committed. |
| Deleted render-count perf tests (subagents strip + crew strip, branch versions) | Ran ad hoc the same way: PASS 4/4; not committed. |
| `pnpm check:changed` | PASS: 43/43 checks, including unit tests, main-blocking-helper-ratchet, main-blocking-api-ratchet and e2e-typecheck-ratchet |

`config/main-blocking-api-baseline*` is untouched; the only config diff vs main is the 5 helper-baseline rows below. `worker-dock-activity.ts` has no row.

## Baseline rows (config/main-blocking-helper-baseline.txt)

```
1 src/main/runtime/orchestration/db/schema/worker-dock-schema.ts # one backfill transaction when the worker dock tables are first installed at database open; later dock facts are written by triggers inside lifecycle statements that were already synchronous
1 src/main/runtime/orchestration/dock/worker-dock-acknowledgment.ts # only on the user's Clear, Clear all or Show in dock again click; no passive caller
1 src/main/runtime/orchestration/dock/worker-dock-provider-failures.ts # only when a provider subagent or command fails: one transaction per failure batch, so a failure stays until the user clears it; successful child events never reach the database
3 src/main/runtime/orchestration/dock/worker-dock-read-snapshot.ts # one consistent read transaction (BEGIN, never IMMEDIATE) per dock read: the cold seed of a visible unknown source, subscribe, a lifecycle or visible activity change of this chat's own workers, or a roster window the user loads; unrelated wakes skip it by version and hidden chats never read
1 src/main/runtime/orchestration/dock/worker-dock-read.ts # the dock reads described for worker-dock-read-snapshot.ts, through that one helper
```
They follow main's `N path # why` format, and the counts are current: the ratchet passes on the final head.

## Perf counts (ad hoc harness in a local scratch directory, not committed)

Main side: a real in-memory `OrchestrationDb` with N ready workers for chat A and 3 workers for an unrelated chat B. There is one `subscribeWorkerDock` producer for A, with the same pane-filtered status subscription that `worker-dock-methods.ts` uses. SQL is counted through `prepare`/`exec` spies, and row writes through `total_changes()`.

| N workers | 100 bare crew wakes | chat B worker fails | 100 unrelated-pane status changes | 50 own heartbeats (no visible change) | own running→idle |
|---|---|---|---|---|---|
| 0 | 0 SQL, 0 refresh, 0 emit | 0 SQL | 0 SQL | 0 SQL | 0 SQL |
| 2 | 0 / 0 / 0 | 0 SQL | 0 SQL | 50 indexed SELECTs, 0 row writes, 0 emits | 1 read (9 stmts, BEGIN/COMMIT read txn), 0 row writes, 1 emit |
| 20 | 0 / 0 / 0 | 0 SQL | 0 SQL | same: 50 SELECTs, 0 writes, 0 emits | same |
| 200 | 0 / 0 / 0 | 0 SQL | 0 SQL | same: 50 SELECTs, 0 writes, 0 emits | same |

All status listeners are released on unsubscribe (0 left).

Renderer: 200 chats with worker presence. A hidden pane makes 0 subscribes and 0 reads, and a parked window makes 0 subscribes and 0 reads. A visible control makes 200 subscribes and 200 seed reads, which proves the harness detects RPCs.

From the code:
- An unrelated wake costs one in-memory `workerDockSources.version()` lookup per open producer; that class never reads SQLite.
- An unrelated status change costs one `Set.has`.
- Hidden or parked chats get `noopSubscribe`; a source with no workers gets no feed; the cold seed fires once per source, only while visible.
- Status churn: 0 writes. The existing committed test proves 200 heartbeats plus a visible change cause 0 writes.

Gap: an own-worker heartbeat with no visible change still costs 1 indexed SELECT (`worker_dock_source_state`) plus an in-memory loop over the ready workers, while the chat is visible. That is work, though not a write.

## Fixture shots (seeded component fixture only; no Orca instance, desktop or user data)

Fixture `native-chat/tools/tasks/dock/NativeChatWorkerDock`: a bot Home Chat with ORCA-18 and ORCA-19 running and ORCA-20 waiting on you, rendered at scale 2. Directory: shots/ (on the M4 worktree)

- native-chat__tools__tasks__dock__NativeChatWorkerDock--botHomeChatFolded.{light,dark}.png (720 px, folded)
- native-chat__tools__tasks__dock__NativeChatWorkerDock--botHomeChatOpen.{light,dark}.png (720 px, unfolded)
- native-chat__tools__tasks__dock__NativeChatWorkerDock--botHomeChatNarrowFolded.{light,dark}.png (390 px, folded)
- native-chat__tools__tasks__dock__NativeChatWorkerDock--botHomeChatNarrowOpen.{light,dark}.png (390 px, unfolded; ORCA-18 sits below "More below")

Gap: the fixture's composer is a placeholder shell, not the real `NativeChatComposerField`, and these are component shots, not the full chat pane.
