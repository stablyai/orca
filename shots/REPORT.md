# Sticky workers dock: UX-I2 and C2 fixes (M4 Air)

- Branch: AmethystLiang/sticky-workers-design (stablyai/orca). No PR yet.
- Old head: 9e12bb2fea08 → **new head: 351f0c995d53**, pushed with `--force-with-lease`.
- Rebased onto main **4c0cc636577**. Main had started to conflict, but only in `config/main-blocking-helper-baseline.txt`: main added a `paired-server-ask-decisions.ts` row next to the dock rows. I kept both, in path order.
- New commits on top of the rebased branch:
  - `38632ed6366`: the UX-I2 fixes.
  - `351f0c995d5`: the C2 fixes.

All evidence comes from seeded fixtures or a hidden, isolated e2e build driven by the stub Claude. No real Orca instance, desktop, account or user data was used.

## UX-I2 findings

1. **HIGH: the newest ask is shown in full.** The top needs-attention row is now a _lead row_ with its own layout:
   - First line: name, state label in the state colour, and time.
   - Below it: the worker's full question (the open approval's summary title) in up to 3 lines. A failed lead row shows its title and reason instead.
   - Then a **Show** button, which opens the worker or result exactly as clicking a row does.

   The other rows stay one line. The roster's height budget grows by the lead row's extra height, so the compact rows below it still show. The full question is also in the lead row's tooltip.
   - At 720 px, ORCA-20's question fits on one line, untruncated.
   - At 390 px it takes 2 lines; at 320 px, 3 lines.
   - A longer question clamps at 3 lines (see the long-list shots).

2. **MED: the folded header now carries urgency.** I chose the icon swap: when the needs-you count is above 0, the header's robot icon becomes the amber "?" state icon (`text-chat-warning`, the Waiting token) in both themes. With nothing needing you, the robot stays (live shots 1, 2 and 4: "1 failed" keeps the robot). Count parts no longer break inside themselves ("1 failed" stays whole at 320 px).
3. **MED: the floating button never covers Send.** A visible structured chat's message box now registers with the floating button's existing keep-clear registry (`useKeepFloatingTerminalTriggerClear`, as on the item page's comment box). The button therefore moves off the box from any saved or default position. The proof renders the **real** `NativeChatComposerField`, with its Send button, plus the real `FloatingTerminalToggleButton`, with the browser window set to 390 or 320 px (`window/*.png`, `window/window-width-report.json`):

   | case                                                                                | window | button top–bottom | Send top–bottom | overlap |
   | ----------------------------------------------------------------------------------- | ------ | ----------------- | --------------- | ------- |
   | default position                                                                    | 390    | 72–108            | 773–805         | none    |
   | default position                                                                    | 320    | 72–108            | 773–805         | none    |
   | saved position right on Send (it would cover Send: `savedSpotWouldCoverSend: true`) | 390    | moved to 367–403  | 773–805         | none    |
   | same, dock folded                                                                   | 320    | moved to 627–663  | 773–805         | none    |

- **Optional item:** at narrow widths, "Status changed" is now right-aligned with the time column.

## C2 findings

- **C2-1 (P2):** provider failures are now stored and invalidated under `workerDockSourceOfSession(subject.sessionId)`, the chat's /clear root.
  - Test: `worker-dock-source.test.ts` › "keeps a provider failure from after /clear in the root chat dock until its Clear". It uses the real reconcile path, reports from the cleared-into session, shows the failure via both the root and live parties, and clears it. It **fails with the fix reverted**.
- **C2-2 (P2, perf):** `workerDockActivitySource` now owns the subscription. A status-row change on a pane that isn't one of the dock's own ready workers' panes costs a `Set.has`. An own pane's change costs one per-pane status read and a signature compare (state, state start, host, fresh), and wakes only if that signature changed.
  - The refresh after a real change reads only the candidate panes, through the new `runtime.readAgentStatusOfPanes`. That is the same filtering as `getAgentStatusSnapshotFn`, built from the existing per-pane read. The activity code's runtime type no longer includes the every-pane snapshot.
  - `session-worker-liveness` now accepts a per-pane reader as well as an array.
  - Test: `worker-dock-read.test.ts` › "does no SELECT and no every-pane snapshot for a heartbeat that changes nothing shown". It runs 50 own heartbeats plus 50 unrelated-pane changes through the real `subscribeWorkerDock` producer: **0 SQL statements prepared, 0 emits, 50 single-pane reads**. A real running→idle change then emits. Without the signature check the same test sees 50 SELECTs, so it fails.
- **C2-3 (P2):** a cold seed is marked done only after its read succeeds. A failed seed runs again on the next park-visibility change or the next visible mount, and an in-flight set prevents duplicates.
  - Test: `worker-dock-feed.test.tsx` › "seeds a source again after a failed cold read, and never after one that succeeded". It **fails on the old code**.
- **C2-4 (P2):** the new `NativeChatStructuredDock` reads the chat's pinned approvals and renders the dock frame whenever there is work, a crew, **or an open worker prompt**. The strip appears only with work or a crew.
  - It shares the per-party approval stream that the transcript's approval timeline already opens, so it adds no stream.
  - Test: `NativeChatStructuredDock.test.tsx`. The now-unused `NativeChatPartyWorkerApprovalStack` was removed.
- **P3:** the backfill prepares its statement once. `retainProviderFailures` notifies only when a row was inserted, and also prepares once per batch.
- **Perf contract:** `use-structured-native-chat-subagents.performance.test.tsx` is re-landed unchanged from 3927ce3 and passes (the strip renders once over 50 session updates). The crew render-count test was re-run ad hoc and passes 3/3; it is not committed.

## Live run: seeded e2e build, isolated profile, hidden

This was an ad hoc, uncommitted spec on the repo's electron-headless Playwright harness, with `ORCA_BACKGROUND_LAUNCH=1`, a temp profile and HOME, and a seeded temp repo. The stub `structured-claude-stub.cjs` got a `dock-fail` prompt that emits a background `local_bash` task and then `task_notification status: failed`. The spec and the stub diff are in `harness/live/`. The run started from an `env -i` allow-listed environment with no tokens or keys, and left no processes behind.

- Window: `visible: false, focused: false` throughout.
- Steps: hello → `/clear` ("Context cleared") → `dock-fail` → the header reads "1 failed" → open the dock: the lead row shows command · Failed · "Verify the journal" · "Verification exited with code 1." · Show (live-1, live-2).
- Clear (×): the dock frame is gone (live-3).
- Restore: `orchestration.workerDockAcknowledge acknowledged:false` returns ok, and "1 failed" is back (live-4). Provider failures have no "Show in dock again" button; that button exists only on worker results. This RPC is the one the button uses.
- **Finding:** in this build, `/clear` of a structured chat keeps its Orca session and only swaps the provider session under it (one record, no `replacementSessionId`). So the live run proves the in-place clear plus failure plus clear/restore path. The `replacementSessionId` lineage that C2-1 fixes, as in a bot Home Chat, is covered by the unit test above, not by this run.

## Gates (final head 351f0c995d53, after the rebase)

| Gate                                                                                         | Result                                                                                                                                      |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused dock tests: dock/_, worker-dock-methods, tasks/_, subagents/*, background-tasks-view | PASS, 11 files, 31 tests                                                                                                                    |
| `pnpm tc:node`, `pnpm tc:web`                                                                | PASS                                                                                                                                        |
| oxlint on changed files                                                                      | PASS                                                                                                                                        |
| `pnpm check:changed`                                                                         | **PASS, 43/43**, including unit tests, main-blocking-helper-ratchet, main-blocking-api-ratchet, max-lines-ratchet and e2e-typecheck-ratchet |

Baseline: the only config diff from main is the same 5 `main-blocking-helper-baseline.txt` dock rows. Counts and `# why` notes are unchanged, and the ratchet passes. The activity module has no row.

## Perf, from the code

- **Unrelated wakes do 0 work.** A crew wake compares `workerDockSources.version(source)` in memory, with no SQL. An unrelated pane's status change is one `Set.has`.
- **Hidden chats do 0 work.** `dock` is null unless the pane is visible, so a hidden chat has no subscribe, no read, no approvals hook and no keep-clear registration. The cold seed runs only while visible and window-park visible.
- **Status churn makes 0 writes.** Activity stays in memory; the existing "keeps agent-status churn of a running worker out of the database" test still passes. An own-worker heartbeat with no visible change now does 0 SELECTs and 0 every-pane snapshots (C2-2 test). That closes the earlier report's gap of 1 SELECT per heartbeat.
- **New renderer work only in visible chats:**
  - The message box's keep-clear registration: one ResizeObserver plus a childList MutationObserver, which fire only on layout changes.
  - The lead flag, computed inside the existing items memo.

## Shots

- `fixture/`: component fixture `native-chat/tools/tasks/dock/NativeChatWorkerDock` at scale 2, in light and dark. It includes a Failed row (ORCA-21).
  - `botHomeChatFolded` / `botHomeChatOpen`: 720 px.
  - `botHomeChatNarrowFolded` / `botHomeChatNarrowOpen`: 390 px.
  - `botHomeChatSmallFolded` / `botHomeChatSmallOpen`: 320 px.
  - `longListMidScroll` (720) / `longListNarrowMidScroll` (390): 14 workers scrolled halfway. The header stays pinned and rows rest whole.
  - `composer*`: the same fixtures in the runner's fixed 1280-px window, so the floating button sits off-frame; use `window/` for that proof.
- `window/`: the same fixtures with the browser window at the fixture width.
  - `composerDefault390`, `composerOverSend390`, `composerDefault320`, `composerOverSend320`.
  - `longListMidScroll`, `longListNarrowMidScroll`.
  - `window-width-report.json`: rects for Send and the button; for the long lists, 1 scrolling element in the dock (no nested scrollbar), no row sliced at the roster's edges, and the scrollTop.
- `live/`: the four cropped live captures and `live-report.json` (temp paths redacted).
- `harness/`: `capture.mjs`, the window-width capture script; `live/` holds the ad hoc spec and the stub diff.
