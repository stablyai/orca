# Kill all sessions also closes terminal tabs

GitHub: https://github.com/stablyai/orca/issues/8001
Branch: `bug-kill-all-sessions-doesnt-kill-terminals`

## Problem

Settings → Manage Sessions and Resource Manager expose **Kill all sessions**. The action currently calls only `window.api.pty.management.killAll()`; it does not remove renderer terminal tabs or dispose xterm instances.

The main handler is narrower than the UI wording:

- `pty:management:killAll` snapshots sessions from the current and legacy **daemon** adapters, shuts them down in parallel, then polls only those initial IDs.
- It does not inventory SSH or runtime-hosted terminals. A degraded local provider is also outside the management adapter set.
- The nominal poll sleep budget is 6.5 seconds (65 × 100 ms), but adapter round-trip time is additional. Daemon requests time out after 30 seconds and connection setup has separate 5-second steps, so total latency can be much longer.
- Failed adapter listings are dropped by `collectSessions`, so counts are not authoritative when an adapter is unreachable. This applies during polling too: an adapter that listed an initial session and then becomes unreachable can make that session disappear from `remainingCount` and be counted as killed without a confirming listing.

Renderer exit handling then preserves two important startup-failure states:

- a sole, freshly spawned pane that exits before any user input; and
- a freshly split pane that exits before input or output.

Those guards are correct for direnv/shell setup failures, but they cannot distinguish an explicit bulk kill. A sole fresh-spawned pane remains if the user never typed, even if it produced output or lived for a while; typed/reattached panes normally close through the existing exit path.

## Goal and invariant

After confirmation, every terminal tab that existed in the invoking desktop renderer at that moment is removed, including dead/no-PTY tabs, and its renderer resources are disposed. Terminal tabs created later are not targeted. Initial daemon sessions still receive the existing management shutdown request, while current non-runtime PTY bindings owned by the targeted tabs receive exact per-ID shutdown requests.

The target is the confirmed terminal **surface ID**, not a liveness inference. If the same targeted tab rebinds before cleanup completes, it is still closed; a newly created tab ID survives.

## Non-goals

- Changing **Restart daemon**, which intentionally leaves panes available to reopen.
- Deleting or sleeping worktrees, closing browser/editor tabs, or killing the daemon process.
- Changing the sole-pane/fresh-split startup-failure guards.
- Promising an immediate OS working-set drop; GC and allocator behavior are nondeterministic. The deterministic contract is that tabs/xterms are released and observable daemon/exact-binding shutdown-request failures are surfaced. Runtime-host result propagation remains an accepted gap below.
- Turning this issue into a new cross-provider global kill API. Exact `pty.kill(id)` calls for current bindings of the confirmed tabs are in scope; inventorying and killing unrelated provider sessions is not.

## Design

### 1. Snapshot terminal surfaces once

At confirmation, before `onKillAllStart` and before the first `await`, collect and deduplicate terminal entity IDs from both `tabsByWorktree` and terminal entries in `unifiedTabsByWorktree`. Include the floating-terminal workspace.

Keep this immutable target set through the async daemon call:

- a target already closed elsewhere becomes a no-op;
- a target moved between groups/worktrees is resolved from current state and still closes;
- a terminal created after the snapshot is never closed.

Do not snapshot all terminal IDs again after the daemon call, and do not retain the confirmation-time worktree as cleanup authority. The target ID is immutable; ownership and active-last ordering are resolved again from current state immediately before cleanup.

### 2. Keep daemon shutdown semantics, then close the snapshot

Call the existing `window.api.pty.management.killAll()` once. After it settles, resolve the still-present targets and deduplicate their current `ptyIdsByTabId` entries. These are the renderer's current binding ownership records, not independent liveness proof; do not pull IDs from `tab.ptyId`, deferred SSH restore state, or `terminalLayoutsByTabId.ptyIdsByLeafId`, which can be restore hints rather than current ownership.

Force-close every snapshotted surface through `closeTerminalTab(id, { force: true })`, then await one existing `window.api.pty.kill(id)` call for each captured non-`remote:` PTY ID. Run both phases for management success, partial success, and IPC rejection because the confirmation explicitly covers closing the terminal surfaces. Use per-target/per-PTY settlement so one unexpected store or provider failure does not stop the remaining cleanup. Already-gone PTYs are successful no-ops in the main handler; other exact-kill rejections are reported separately.

Close targets outside the cleanup-time `activeWorktreeId` first and targets currently owned by it last. A tab moved into the active worktree or a workspace selected while the daemon call was pending must therefore move to the last partition. Let `closeTerminalTab` choose the existing post-state for the last local terminal: editor, then browser, then `setActiveWorktree(null)`. Do not pre-clear `activeWorktreeId`; the sleep flow needs that ordering because it leaves tab records mounted while clearing PTYs, whereas this flow removes the tabs. Add active-switch and active-last regression tests and only adopt sleep-intent/deactivate-first if those tests prove a respawn.

This is not one backend call end-to-end. The coordinator issues one daemon-management IPC, one renderer close per unique target, and at most one exact kill IPC per unique current non-runtime PTY binding. The explicit exact kills make local/SSH shutdown requests settle before caller refresh instead of relying on React unmount timing. A mounted transport may race that request and issue an idempotent duplicate during unmount; count that separately in live performance evidence. A still-bound daemon session can receive the exact retry after the management poll, so daemon toast counts remain the management handler's earlier reported snapshot, not final process truth. Runtime-hosted tabs additionally issue one `session.tabs.close` flow per tab.

The coordinator must live outside the hook (for example, `kill-all-terminal-surfaces.ts`) and must not gate cleanup on `mountedRef`. Navigating away or unmounting the invoking popover/settings component while IPC is pending does not revoke an already confirmed destructive action; only React callbacks and hook state updates remain mount-gated.

### 3. Do not add a post-kill orphan sweep

Do not call `pty.listSessions()` and kill everything returned after the management call. Exact kills captured from `ptyIdsByTabId` for the immutable target surfaces are allowed and required; they do not discover or cross into unrelated sessions.

The management handler already targets daemon orphans in its initial snapshot. A later broad sweep would cross the confirmation boundary by killing local/SSH sessions or fresh sessions created while the existing poll was running. It would also add provider inventory fan-out to a recovery action and conflict with the main handler's initial-ID accounting.

The existing explicit **Kill orphan terminals** action remains separate.

### 4. Make completion and failure copy honest

Have the renderer cleanup return a bounded summary: target count, targets absent at completion, failed close attempts, exact PTY kill requests accepted/rejected, and daemon result/error. Verify absence in both terminal and unified state after each close attempt. Toasts must report renderer cleanup separately from daemon counts; do not show **No sessions running** when terminal tabs were closed.

Because the management API suppresses adapter-list failures, copy must describe daemon counts as reported, not claim that every daemon process was verified dead. Returning adapter errors is a follow-up unless this PR chooses to widen the API. Exact `pty.kill` rejection counts may be stated as failed shutdown requests, not as proof that the processes remain alive.

Examples of states, not required wording:

- all daemon targets were reported exited, exact shutdown requests were accepted, and tabs closed: success;
- `remainingCount > 0`: warning that management reported daemon processes not exited before exact binding cleanup;
- management IPC rejected: error that tabs closed, with daemon shutdown unverified and any exact PTY kill failures called out;
- no daemon sessions and no terminal tabs: existing informational state.

Run `onKillAllSettled` only after surface removal and exact PTY kill settlement. `closeTerminalTab` returns before React unmount effects run, so surface removal alone is not a sufficient boundary for Resource Manager's `pty.listSessions()` refresh. Keep one confirmation dialog and update its description to say that terminal tabs across workspaces close and unsaved terminal work is lost.

### 5. Provider limits

`closeTerminalTab` synchronously prunes host-backed local mirrors but currently returns `void` and discards the promise from `closeWebRuntimeSessionTab`. The underlying helper is already awaitable: its close request has a 15-second timeout and, after success, it awaits an eager list refresh with another 15-second timeout. Its boolean can therefore settle after roughly 30 seconds, while close-intent suppression expires after 10 seconds. This change must not claim verified runtime-host completion unless the bulk helper propagates that existing result and aligns the intent lifetime.

For this Windows/local bug, runtime-host cleanup is best-effort and an explicit accepted gap. A follow-up may propagate the existing async close result through terminal-tab actions and align the RPC timeout/intent lifetime. SSH must be exercised if the fixture is available; otherwise record live SSH process absence as an accepted gap. No provider-specific local filesystem or process assumptions are added.

## Data flow

```text
confirm
  → snapshot unique terminal surface IDs
  → pty.management.killAll()             daemon current + legacy; existing polling
  → resolve current target ownership + bound PTY IDs
  → close snapshotted tabs, active last  renderer/xterm cleanup; runtime-host close starts
  → await exact non-runtime pty.kill IDs local/SSH acknowledgement; no provider sweep
  → toast daemon result + surface/exact-kill summary
  → caller refresh
```

## Concurrency and consistency

| Case                                      | Required behavior                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| No daemon sessions; dead/empty tabs exist | Close target tabs and report tab cleanup, not “No sessions.”                                                      |
| Daemon session refuses to exit            | Close the confirmed tab; report that management saw it remaining before the exact retry. Refresh may expose it as an orphan. |
| Adapter listing fails                     | Close target tabs; do not claim all processes were verified dead. Existing management counts may read as zero.    |
| Management IPC rejects                    | Still close confirmed tabs and issue exact current-binding kills; report daemon uncertainty and exact-kill errors. |
| New tab/session during the wait           | New tab ID survives. No post-snapshot provider sweep.                                                             |
| Target closes or moves during the wait    | Missing target no-ops; moved target closes by current ownership.                                                  |
| Target tab rebinds to a new PTY           | Close it because the confirmed surface, not the old PTY snapshot, is the authority.                               |
| Pinned or split terminal                  | `force: true` bypasses a second prompt; closing the tab closes all of its panes.                                  |
| Active last terminal                      | Existing close routing selects editor/browser or deactivates; no replacement terminal spawns.                     |
| Two overlapping invocations               | Cleanup is idempotent by tab ID. Each main call retains its own initial daemon snapshot/counts.                   |
| Binding changes after exact-ID capture     | Surface close still wins; transport unmount kills the replacement, but that late kill is not in the awaited count. |
| Runtime-host snapshot races close         | Existing close intent suppresses stale snapshots temporarily; host completion remains an accepted gap.            |
| External/mobile session creation          | Sessions created after the main/renderer snapshots are not chased. Existing PTY-exit publication updates mirrors. |

Orca's production UI currently tracks a single desktop `mainWindow`/renderer. The main daemon action is process-global while renderer cleanup is renderer-local. If multiple desktop windows become supported, this action must be broadcast from main with an action ID and per-window acknowledgement; “shared store probably mirrors it” is not sufficient.

## Tests and reliability gate

Add an experimental, `protection: "partial"` `terminal-session.kill-all-surface-cleanup` entry to `config/reliability-gates.jsonc`, owned by `terminal-runtime` at the renderer/main contract layer. The entry must name the focused coordinator and `pty-management` test files/commands and include non-empty assertion refs; otherwise the manifest checker rejects a partial gate.

- **Invariant:** confirmed terminal surfaces close exactly once; later-created surfaces survive; no broad post-snapshot kill occurs.
- **Failure source:** issue #8001 plus the sole-fresh/fresh-split exit guards that intentionally preserve dead startup-failure panes.
- **Deterministic oracle:** the initial tab IDs disappear from both terminal/unified state, non-terminal and later-created tabs remain, active state is valid, exact kills are issued only for deduplicated current target bindings, all exact-kill promises settle before the caller callback, and no `pty.listSessions` sweep occurs. Provider inventory absence is live validation, not the renderer-unit oracle.
- **Diagnostics:** emit one content-free bounded summary with target/absent/failed-close counts, exact-kill accepted/rejected counts, and the daemon result or error. Runtime-host completion remains unknown until terminal-tab actions propagate the existing async close result.

Required deterministic coverage:

- snapshot/dedup across multiple worktrees, unified-only terminals, splits, and floating terminals;
- pinned close with `force`, while browser/editor tabs remain;
- terminal added after the snapshot survives; missing/moved target behavior;
- active-last post-state for editor, browser, and no-other-content cases, including no auto-spawn;
- coordinator ordering for success, partial result, zero sessions, and rejected management IPC;
- exact binding capture excludes restore hints and `remote:` IDs; late-created tab bindings are not captured;
- exactly one management call, zero `pty.listSessions` calls, one close attempt per unique target, and one coordinator-issued exact kill per unique captured non-runtime PTY ID;
- invoking component unmount during the management wait does not cancel store/provider cleanup or invoke mount-gated callbacks;
- existing `src/main/ipc/pty-management.test.ts` cases remain green.

Electron validation on Windows must reproduce an empty shell plus an established terminal, invoke each entry point, and prove:

- target terminal tabs and `.xterm` surfaces are gone;
- initial local/daemon PTY IDs are absent after settle, except daemon IDs reported remaining and exact IDs whose shutdown request failed;
- a terminal created after confirmation survives;
- Resource Manager and Manage Sessions refresh to the same result.

Planned provider/platform accounting:

| Row | Planned status |
| --- | --- |
| Local PTY / daemon / Windows | Covered by deterministic coordinator/main tests plus the required live Electron run. |
| macOS / Linux local and daemon | Shared code is covered deterministically; live process absence remains an accepted gap until run there. |
| SSH | Exact request/settlement is covered by provider-contract mocks; live remote-process absence is covered only when the SSH fixture runs, otherwise accepted-gap. |
| WSL | Uses the local exact-ID path, but real WSL process absence is an accepted gap unless included in the Windows run. |
| Remote runtime | Local mirror removal is covered; host completion is accepted-gap while `closeTerminalTab` discards the async result. |
| Mobile/relay | No newly created session is chased; shared host-tab disappearance and live relay shutdown remain accepted gaps unless exercised with their fixtures. |

Screenshots are UI evidence only; they do not prove PTY or memory cleanup.

## Performance and blast radius

No interval, watcher, or extra provider listing is added. The existing management call can wait for 65 sleeps plus adapter latency. The coordinator adds at most one existing exact-kill IPC per unique current non-runtime PTY binding; record both those calls and any idempotent unmount duplicates as part of the performance evidence.

Repeated `closeTerminalTab` calls are not O(tabs): target resolution and store cascades scan/clone multiple maps per close, so worst-case renderer work is superlinear. Measure the synchronous close phase with a representative high-tab fixture (at least 100 terminal tabs). Record close attempts, Zustand writes, duration, and long tasks. If it creates a >50 ms renderer task, add a focused bulk reducer or yield-safe batching rather than declaring the rare action free.

For resource reclamation, prefer deterministic counts: zero target `TerminalPane`/xterm instances, released listeners/transports, and no initial PTY IDs. A repeated open/kill cycle may supplement this with heap/working-set evidence, but absolute memory deltas are not a stable pass/fail oracle.

## UI quality bar and screenshots

No new layout or visual token is needed. Keep the existing shadcn `Dialog`/destructive `Button`, compact typography, dismissal lock while busy, and accurate consequence-first copy. The post-state must never be a blank/crashed TerminalPane or a wall of dead empty panes.

Required review screenshots:

1. Resource Manager before kill with an empty terminal and an established terminal visible in the workspace.
2. Resource Manager kill-all confirmation with updated close-tabs copy.
3. Matched post-kill workspace showing target terminal tabs gone and refreshed counts.
4. Manage Sessions confirmation or post-state, proving the second entry point uses the same behavior.

## Lightweight Eng Review

- **Scope:** renderer surface cleanup layered on the existing daemon management action; no daemon redesign and no broad orphan/provider sweep.
- **Architecture/data flow:** main owns its initial daemon-session shutdown; renderer owns the confirmed terminal-surface snapshot, exact current-binding shutdown, and tab/xterm disposal; runtime-host close remains behind existing routing.
- **Failure modes:** partial/rejected daemon kill, exact provider-kill failure, no-session cleanup, pinning, splits, cleanup-time active selection, new/moved/disappeared tabs, same-tab rebind, overlapping actions, invoking-component unmount, stale runtime snapshots, adapter-list uncertainty, and future multi-window ownership are explicit above.
- **Tests:** deterministic state/coordinator and main-handler tests plus Windows Electron proof; a new experimental partial reliability gate records provider gaps.
- **Performance/blast radius:** one existing management IPC, bounded exact per-PTY kill IPCs, no new listing/polling, but N close cascades require measurement because current helpers are not linear or atomic.
- **UI quality bar:** existing dialog primitives and truthful copy; screenshots prove both entry points and the terminal-free post-state, not memory reclamation.
- **Residual risks:** daemon adapter listing can stall until client timeouts and failures are treated as empty; terminal-tab actions discard the runtime-host close result and its 10-second intent is shorter than the possible two-request close flow; a binding created after exact-ID capture is killed only by transport unmount; live SSH/WSL/mobile behavior may remain accepted gaps until fixtures prove it.

## Rollout

1. Add the snapshot/coordinator and deterministic tests.
2. Wire it only through `useDaemonActions.runKillAll`; keep the coordinator outside the hook and update toast/dialog copy.
3. Add the experimental reliability gate and performance count/latency evidence.
4. Run focused tests, typecheck, lint, and max-lines ratchet checks.
5. Validate both entry points in Electron on Windows and capture the required screenshots.
6. Force-add this doc when staging because `docs/**` is ignored by default.
