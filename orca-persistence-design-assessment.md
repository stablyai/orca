# Orca persistence: terminal reattach fast path

Date: September 7, 2026

Status: Fix 1 is implemented on this branch. This document describes its durability boundary and local measurements. Fixes 2 and 3 remain proposals; no live before/after validation of the implementation has been performed.

## Review evidence (September 7)

The review found a false durability acknowledgement after `flushAsync`: late session writes do not advance the generation once shutdown begins. The fast path now excludes `quitFlushStarted`, preserving the existing synchronous-flush error. A regression failed before that guard and passed afterward.

The binding write now has one flush and rollback boundary. Session mutation does not depend on tracing. Trace sampling uses the existing recorder's decision hook without a per-call dropped flag or a separate flushed flag. Diagnostic scripts reuse one inspector connector and close it when process verification fails.

- Invariant: `persistPtyBinding` cannot acknowledge an unpersisted late-shutdown binding; unchanged durable bindings avoid cloning and synchronous flushing.
- Oracle: disk contents and the thrown shutdown error, plus zero clone/flush counts on repeated local, SSH, and runtime bindings.
- Gates: the persistence suite and affected deterministic coverage from `terminal-session.explicit-close-retirement`; its live Electron journeys were not run.
- Validation: 931 tests passed and one opt-in metadata benchmark skipped; a subsequent targeted run passed 80 tests, including SSH reattach and terminal-close continuity. Node typecheck, targeted lint, formatting, and whitespace checks passed.
- Coverage: host partition behavior is tested for local, SSH, and paired runtimes; folder-workspace and binding-recovery tests are included in the persistence suite. PTY I/O, WSL process execution, platform launch policy, and wire formats are unchanged by the review fixes. No live platform matrix or before/after typing-latency measurement was collected.

Concurrent edits began adding call-origin instrumentation after this validation. That work is separate from these review fixes; implementation descriptions below about omitted origin metadata need reconciliation when those edits settle.

## Problem

Every terminal pane that mounts or remounts calls `Store.persistPtyBinding`, which clones the workspace session, mutates it, and calls `flushOrThrow`. The flush serializes the whole persisted state (9.2 MB on the measured install) on the Electron main thread, then compares its hash to the last written hash and usually skips the disk write. The serialization is paid whether or not the write happens.

Live instrumentation on the running app measured four such calls in 30 seconds, each 59 to 100 ms, all with tab PTY, leaf PTY, layout membership, and incarnation already matching the request. Twelve serializations in that window totaled 468 ms of main-thread time. A real terminal keydown queued 117 ms during one of the calls; the call accounts for about 16 ms of that, so this is a confirmed stall, not the whole lag. Details and capture artifacts: [the live investigation notes](orca-live-lag-investigation.md).

The trigger is the renderer's cold-park policy in `src/renderer/src/components/terminal-pane/terminal-hidden-view-parking.ts`: at most 4 workspaces and 6 tabs stay warm, so on a many-worktree install nearly every workspace switch remounts every pane in the revealed workspace, and each pane reattaches. A three-pane workspace is three back-to-back flushes.

## Change

The implementation adds an early return to `persistPtyBinding` in `src/main/persistence/loading-store/pty-binding-persistence.ts` that fires when the requested binding is already in memory and already on disk. Nothing is cloned and nothing is serialized on that path.

### Placement

The check runs after the four existing refusal checks (`expectedSourceBinding`, `expectedBinding`, `mayReviveRetiredSurface`, `mayCreate`) and before the non-local partition re-point and `cloneWorkspaceSessionState`. Refusal semantics stay exactly as they are: every `return false` today still returns `false` first.

### No-op predicate

All of the following must hold. Any miss falls through to the existing code unchanged.

| Condition                                                                                                                            | Why                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `args.expectedSourceBinding === undefined`                                                                                           | The split path always changes membership and arms the topology fence.              |
| `isTerminalLeafId(args.leafId)`                                                                                                      | Legacy leaf ids take the early flush branch and never write layout state.          |
| Tab exists in `session.tabsByWorktree[bindingWorktreeId]` with `tab.id === args.tabId` and `tab.ptyId === args.ptyId`                | Otherwise the call mints a tab.                                                    |
| `session.terminalLayoutsByTabId[args.tabId]` exists, `layout.root` is non-null, and `layoutContainsLeafId(layout.root, args.leafId)` | Otherwise the call mints or splits the layout.                                     |
| `layout.ptyIdsByLeafId?.[args.leafId] === args.ptyId`                                                                                | The load-bearing binding.                                                          |
| `session.terminalPtyIncarnationsByPaneKey?.[paneKey] === args.incarnationId`                                                         | Strict equality: undefined on both sides is a match; undefined on one side is not. |
| `args.expectedBinding === undefined \|\| args.expectedBinding.incarnationId === args.incarnationId`                                  | A reconciled incarnation must still bump the topology fence.                       |
| `!session.terminalSurfaceTombstonesByPaneKey?.[paneKey]`                                                                             | A tombstone is cleared by the write path; it is state the call would change.       |
| Binding is durable (next section)                                                                                                    | In-memory equality alone can match a binding still waiting in the debounced save.  |

When the predicate holds, `return true`. The `true` return matters: `persistAdmittedStablePaneBinding` in `src/main/ipc/pty/pane/stable-owner.ts` throws `terminal_pane_owner_changed` on `false`, and `spawn-commit-persist.ts` uses the `true` result to suppress its second binding write.

### Durability check

```ts
!runtime.quitFlushStarted && runtime.lastDurableWriteGeneration >= runtime.writeGeneration
```

`scheduleSave` bumps `writeGeneration` before it arms the timer. `writeToDiskAsync` raises `lastDurableWriteGeneration` after the file is durably renamed or proven byte-identical by the hash comparison. A pending mutation leaves the durable generation behind. A synchronous flush can close that gap while an older async promise is still pending: it first removes the in-flight temporary file, so a parked async rename fails instead of overwriting the newer snapshot; if the rename already completed, the sync write wins. Thus no additional pending-write guard is needed. The existing async-write syscall test covers the parked-rename race.

Before this change, `writeToDiskSync` raised the counter only after a real rename. On a hash match with `force` unset it returned without touching it, while `flushOrThrow` had already bumped `writeGeneration`. Left alone, every sync flush that nets to unchanged state parks the counter one behind and also clears the debounce timer, so nothing heals it until unrelated state schedules an async write. The fast path would fall through on the next reattach, hit the same hash match, and stay disabled. This change therefore includes a one-line fix in `writeToDiskSync`: on the unforced hash-match return, set `lastDurableWriteGeneration = max(lastDurableWriteGeneration, writeGeneration)`, mirroring the async branch. A matching hash means the file already holds this state, which is exactly what the counter records. The `force` path is excluded on purpose: it exists because an async rename may be racing past the generation check, so the file's contents are not yet proven.

`PtyBindingPersistenceOperationsRuntime` reads the existing generation counters and quit state for eligibility, plus pending-write and timer state for trace metadata. No new durability tracking state is introduced.

The generation check covers the entire persisted state. Unrelated scheduled changes also block the fast path until a successful save closes the generation gap. This is conservative: there is no separate binding durability cache.

The fast path must preserve the persistence lifecycle: once the final quit flush has started, a matching binding still reaches the existing refusal to synchronously flush. Durable equality does not authorize a late binding acknowledgement during shutdown.

### Why the counter is trustworthy

The counter would lie only if some code set a binding value to the requested value without bumping the generation, leaving memory matching while disk holds an older value. Every writer of binding values under `src/main` was enumerated for this spec, including writers that reach the fields through an alias rather than by property name:

| Writer                                                                                  | Mutates live session?                                                                                                | Saves?                                                                                                                                   |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `loading-store/pty-binding-persistence.ts`                                              | Yes                                                                                                                  | `flushOrThrow` in the same call.                                                                                                         |
| `loading-store/workspace-session-terminal-binding-replay.ts`                            | No, the incoming replacement                                                                                         | Called only from `setWorkspaceSession` paths, which `scheduleSave`.                                                                      |
| `leasing-ssh-ptys/ssh-pty-binding-cleanup.ts`                                           | Yes                                                                                                                  | Calls `scheduleSave` itself when any binding changed. Also only clears bindings to `null` or removes keys, which cannot match a request. |
| `leasing-ssh-ptys/ssh-pty-pane-supersession.ts`                                         | Via the cleanup module                                                                                               | `flush()` after.                                                                                                                         |
| `ssh/ssh-target-id-migration.ts`                                                        | Yes, in place, through a `record` alias for `ptyIdsByLeafId` and directly on `tab.ptyId`                             | Sole caller `leasing-ssh-ptys/ssh-target-reassignment.ts` calls `scheduleSave` when anything changed.                                    |
| `runtime/runtime-terminal-orphan-session-adoption.ts`                                   | No, a `structuredClone`                                                                                              | Result handed to `setWorkspaceSession`.                                                                                                  |
| `restoring-sessions/session-owner-removal.ts`                                           | No                                                                                                                   | New session object handed to `setWorkspaceSession`.                                                                                      |
| `tracking-repos/worktree-identity-migration.ts`                                         | Yes, tombstone worktree ids                                                                                          | Caller in `metadata-lineage-operations.ts` calls `scheduleSave` when changed.                                                            |
| `orca-profiles/profile-project-session-state.ts`, `profile-project-session-transfer.ts` | No, copies for transfer and removal                                                                                  | Results land through `setWorkspaceSession` or a state replace that saves.                                                                |
| `runtime/mobile-session-layout-projection.ts`                                           | No, a projection for the mobile client                                                                               | Never persisted.                                                                                                                         |
| `leasing-ssh-ptys/ssh-pty-lease-operations.ts`                                          | Assigns `.ptyId` on a lease row, not a binding                                                                       | Not a binding writer; listed because the ratchet regex matches it.                                                                       |
| Everything else outside `src/main/persistence`                                          | Spreads into a new object and calls `setWorkspaceSession`; verified for every non-test `getWorkspaceSession` caller. |                                                                                                                                          |

Other code mutates non-binding live state without a bump (SSH lease shutdown marking, lease tombstone retention, the deferred scrollback snapshot migration, load-time diff-comment relocation). None writes a binding value, so none can defeat this predicate. They are out of scope.

### Ratchet test

Keep the table above true without relying on memory. Add `src/main/persistence/loading-store/terminal-binding-writer-boundary.test.ts`, modeled on `src/shared/child-process/child-process-import-boundary.test.ts`:

- Walk `src/main` for `.ts` files, skipping test files, fixtures, and ignored directories the same way that test does.
- Match, on comment-stripped text, assignments to `ptyIdsByLeafId`, `.ptyId`, `.root`, `terminalPtyIncarnationsByPaneKey`, and `terminalSurfaceTombstonesByPaneKey`. Assignment means `=` not followed by `=`, on a property access or index expression. Comparisons and destructuring are not matches.
- Hold the allowlist in `__fixtures__/terminal-binding-writer-allowlist.txt`. Seed it from the regex's actual first run, not from the table. On the current tree that is the eleven files below; a reimplementation must recompute the list and pin the count it finds. The allowlist only shrinks. Add the three assertions from the model: no unlisted writer, no stale entry, offender count equals a literal pin.

  ```
  src/main/orca-profiles/profile-project-session-state.ts
  src/main/orca-profiles/profile-project-session-transfer.ts
  src/main/persistence/leasing-ssh-ptys/ssh-pty-binding-cleanup.ts
  src/main/persistence/leasing-ssh-ptys/ssh-pty-lease-operations.ts
  src/main/persistence/loading-store/pty-binding-persistence.ts
  src/main/persistence/loading-store/workspace-session-terminal-binding-replay.ts
  src/main/persistence/restoring-sessions/session-owner-removal.ts
  src/main/persistence/tracking-repos/worktree-identity-migration.ts
  src/main/runtime/mobile-session-layout-projection.ts
  src/main/runtime/runtime-terminal-orphan-session-adoption.ts
  src/main/ssh/ssh-target-id-migration.ts
  ```

  `ssh-pty-pane-supersession.ts` assigns no binding field itself and is not matched. Pin at the count the first run prints.

- Failure message: "New writer of a terminal binding value. It must bump the persistence write generation (scheduleSave, flushOrThrow, or setWorkspaceSession) in the same operation, or persistPtyBinding's fast path can skip a flush it needed. See orca-persistence-design-assessment.md."

The ratchet catches new files that name the fields. It cannot see a writer that reaches a binding record through an alias, as `ssh-target-id-migration.ts` does with its `record` parameter; that file is caught only because it also assigns `tab.ptyId` directly. The regex is therefore a tripwire for the common case, and the table above is the actual audit. A harness-wide serialization invariant or a frozen session view would defend a stronger property than the fast path needs and were considered and dropped.

## Tests

Extend `src/main/persistence-flush-and-save-scheduling.test.ts`, which already has the repeated-binding inode test at the "Warm-restart re-bind storm" case. Note that in this harness `Store.prototype.flushOrThrow` is installed from `PrimaryStateWriteOperations.prototype` by the class merge at the bottom of `store.ts`, and the binding code calls it through `runtime.flushOrThrow`, an arrow that dispatches on the instance. `vi.spyOn(store, 'flushOrThrow')` on the instance therefore intercepts it, as `persistence-split-pane-incarnation.test.ts` already relies on.

1. **Fast path skips all work.** Bind once. Spy on `store.flushOrThrow` and on `globalThis.structuredClone`. Bind again with identical args. Expect zero calls to each, return value `true`, and inode unchanged.
2. **Pending save still flushes, and the sync no-op raises the counter.** Bind once. Call `store.setWorkspaceSession({ ...store.getWorkspaceSession() })`, which bumps the generation without changing any binding. Bind again identically. Expect `flushOrThrow` called once and the inode unchanged, because the flush hits the hash match and skips the rename. Then bind a third time and expect zero further flushes: this is the assertion that the `writeToDiskSync` hash-match branch now advances `lastDurableWriteGeneration`. Without that fix the third bind flushes again.
3. **Incarnation mismatch falls through.** Bind with `incarnationId: 'a'`, then bind identically with `incarnationId: 'b'`. Expect a flush and the new incarnation on disk.
4. **Undefined versus defined incarnation falls through.** Bind with an incarnation, then bind without one. Expect a flush.
5. **Tombstone falls through.** A tombstone cannot be created through `setWorkspaceSession`: `sanitizeWorkspaceSessionTerminalRetirements` consumes and clears the tombstone map on every session write, which the "raised topology revision" case in `ssh-reattach-pane-cardinality.test.ts` pins. Seed it the way that file's "older profile" case does: write a data file whose session carries the binding, the incarnation, and a tombstone for the same pane key, then `createStore`. Bind identically with `incarnationId` set and `mayReviveRetiredSurface` unset. Expect a flush and the tombstone cleared.
6. **Reconciled incarnation still bumps the fence.** Pass `expectedBinding` with an older incarnation and the same PTY. Expect the topology revision for the repo to advance, per the existing `reconciledIncarnation` logic.
7. **Refusals unchanged.** For each of `expectedSourceBinding` tab mismatch, `expectedBinding` PTY mismatch, `mayReviveRetiredSurface: false` with a tombstone, and `mayCreate: false` with a missing layout, assert `false` is still returned and nothing was flushed. The tombstone and `mayCreate` refusals are already covered in `ssh-reattach-pane-cardinality.test.ts`; the fence refusals in `persistence-pty-binding-reconciliation.test.ts` and `persistence-split-pane-incarnation.test.ts`. Confirm rather than duplicate.
8. **Non-local partition.** Repeat test 1 with an SSH host id to confirm the fast path resolves the session from `workspaceSessionsByHostId` and does not re-point the partition.
9. **Sync hash match raises the durable generation.** Directly: change unrelated state, call `flushOrThrow` twice, and assert the second call performs no rename and leaves `lastDurableWriteGeneration === writeGeneration`. This pins the `writeToDiskSync` fix independently of the binding path.

The tests that actually execute `persistPtyBinding` are the ones built on a real `Store` through `createStore`: `persistence-flush-and-save-scheduling`, `persistence-host-partitioned-ssh-pty-bindings`, `persistence-split-pane-incarnation`, `persistence-pty-binding-reconciliation`, `persistence-pty-binding-leaf-tab-resolution`, `persistence-host-admitted-terminal-membership`, `persistence-worktree-deletion-fencing`, `persistence-ssh-remote-pty-leases`, `ssh-reattach-pane-cardinality`, `runtime/host-terminal-close-persistence-durability`, and `ipc/pty/ipc/spawn-commit-ssh-lease-cardinality`. All must keep passing. Two of them make `flushOrThrow` throw on a rebind to test rollback; both still fall through under the predicate, one because the tab PTY is `null` beforehand and one because the incarnation is being reconciled. The IPC and runtime suites (`pty-dead-owner-respawn`, `pty-persisted-incarnation-repair`, `mobile-session-tabs-part-05`, `mobile-session-tabs-part-08`, `orca-runtime-terminal-retirement`) inject a mock store with `persistPtyBinding: vi.fn()`, so the fast path never runs in them and their flush counts cannot move.

## Verification

Run `pnpm tc:node` and `pnpm test src/main/persistence-flush-and-save-scheduling.test.ts src/main/persistence/loading-store`, then the eleven real-store files above.

See "Measuring eligibility" below for how eligibility is recorded on the user's machine so the rate can be measured with this build.

Then measure on the real install after a day of accumulated state, using the probe through the inspector connection in `config/scripts/orca-main-inspector-connection.mjs`:

- Target: zero `buildStateToSave` calls whose stack includes `persistPtyBinding` during a sequence of workspace switches between parked workspaces, on calls the span recorded as `fast_lane`.
- Then a typing capture with `config/scripts/capture-live-input-lag.mjs`. Report the keystroke queue-delay distribution before and after. Do not claim the lag is fixed from the persistence numbers alone; the unattributed remainder of the 117 ms needs its own capture.

## Measuring eligibility

Each call emits a `persistence.pty-binding` span through the existing local trace sink. It records `binding.outcome` (`fast_lane`, `flushed`, `refused`, or `threw`), host kind (`local`, `ssh`, or `runtime`), save-pending state, and the generation gap at entry. Calls reaching the predicate also record `binding.eligible` and comma-separated `binding.misses`. Refused calls do not evaluate eligibility. `flushed` means the write path completed; it does not mean bytes changed or a rename was necessary.

The sink already provides rotation, consent gating, redaction, and diagnostic-bundle collection. No extra persistence file or network sink is introduced. The attributes contain no pane, PTY, worktree, path, or host identifiers.

Successful fast-path spans have a budget of 200 per 60-second window. Further fast-path spans in that window are dropped; there is no separate sampling flag. Other outcomes are not budgeted. A saturated window therefore cannot supply an exact hit rate: report its count as a lower bound or exclude it from a rate calculation. The budget alone cannot reconstruct dropped calls.

For an unsaturated window, report outcomes, eligibility among evaluated calls, the miss histogram, calls whose only miss is `not_durable`, and the time range covered. The generation gap is global, so `not_durable` can reflect unrelated dirty state as well as a pending binding write. Include duration totals to assess main-thread cost. Rotated logs and bundle size limits can truncate the available time range.

### Reattach hit rate

`persistPtyBinding` cannot tell a fresh spawn from a warm remount: both arrive with a PTY id and an incarnation. Fresh spawns always flush, so a rate over all calls is diluted by however many terminals the user opened. Every caller does know, so each passes an optional `origin` in the args and the span records it as `binding.origin`:

| Call site                                               | Origin                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| `persistAdmittedStablePaneBinding` in `stable-owner.ts` | `result.isReattach === true` gives `reattach`, else `spawn`.     |
| Unfenced write in `spawn-commit-persist.ts`             | Same rule.                                                       |
| Unfenced write in `runtime/spawn-commit.ts`             | `split` when `expectedSourceBinding` is set, else the same rule. |
| Reattach bind in `ssh-relay-session.ts`                 | `relay_reattach`.                                                |
| Anything else                                           | `unknown`, the default.                                          |

`origin` is span metadata only. `persistPtyBinding` does not branch on it, and the predicate and ratchet ignore it.

The headline is fast-lane spans divided by spans with `origin` in `{reattach, relay_reattach}`, reported with the per-origin split. The second number is the count of reattaches whose only miss is `not_durable`; if it dominates, the fast path is correct but a pending save is what blocks it, and the renderer's switch-time write cadence is the next target. `isReattach` means the provider reused a live PTY, so it does not separate a parking-policy remount from an app-restart reattach. Both count. Isolating the parking case would need the renderer to send a reason with the spawn request, which is out of scope.

A first read of 22 spans from the running dev instance, before `origin` existed, found zero fast-lane hits. Four calls at one timestamp were durable with a zero generation gap and matched on layout, leaf PTY, and incarnation, but every one missed on `tab_pty` alone: a tab row holds a single `ptyId` while a tab can hold several panes, so sibling panes in a multi-leaf tab overwrite each other's `tab.ptyId` on every remount and can never converge. That install has seven such tabs. Whether the `tab_pty` check should compare against the pane's own binding rather than the tab's last-written PTY is the open question the origin-tagged rate will size.

The implementation does not record serialized payload size or a `binding.flushed` boolean. The reader script and a separate instrumentation-only release are deferred.

The inspector probe in `config/scripts/persistence-call-probe.mjs` remains a separate historical investigation tool: it records memory equality and call timings, not generation counters. Its captures alone cannot establish fast-path eligibility.

## Safety constraints

- Do not remove or defer `flushOrThrow` for any binding that changes state.
- The `writeToDiskSync` counter fix applies only to the unforced hash-match return. Do not raise the counter on the `force` path or on any failed write.
- Do not change the return value or exception of `persistPtyBinding` for any input the fast path does not accept. The SSH relay reattach in `ssh-relay-session.ts` expires the lease on `false`.
- Do not widen the fast path to the automation, lease, or layout-publish paths; they have their own semantics.
- The `persistence.pty-binding` span carries no pane key, PTY id, worktree id, path, or SSH target id. If a future attribute needs an identifier, hash it or drop it.
- Preserve host partition behavior: resolve the session for the requested host id and never assume local.
- Keep all Windows, WSL, SSH, and relay coverage as it is; the change is host-agnostic and adds no platform branch.

## Deferred: fixes 2 and 3

Recorded so the constraints are not rediscovered.

**Fix 2, small binding transactions.** Persist a binding with only the topology and ownership needed for recovery instead of the whole document. The session clone exists only for `restoreSession` after a failed flush; a narrow rollback must restore the tab row, the layout, the incarnation map, the tombstone map, and the repo topology revision. If bindings leave the single state document, every consumer must follow: backup rotation and `.bak` recovery in `backup-recovery-rotation.ts`, the orcad snapshot member set in `ssh/orcad-state-snapshot.ts` which copies `profiles/` wholesale on remote hosts, profile transfer and move, and downgrade, because an older build reads `orca-data.json` directly and would start with no bindings.

**Fix 3, off-main serialization.** The debounced autosave still serializes the full document synchronously before its first filesystem await. Three constraints: secret encryption in `buildStateToSave` uses Electron `safeStorage` and must stay on main, so only stringify, sentinel substitution, encoding, and hashing can move; the worktree-meta projection settles rows on reference identity, which a structured-clone boundary destroys; and `flushOrThrow` is a synchronous barrier used by binding, retirement, the Codex credit ledger, and quit, which a worker cannot provide. This fix applies to the autosave path only unless every synchronous barrier caller is converted, which is its own change with its own crash-window analysis.
