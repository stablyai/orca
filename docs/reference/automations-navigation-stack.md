# Automations Navigation Stack

## Problem

- `worktree-nav-history.ts` models view entries as `'tasks'` only; `'automations'` cannot be recorded or replayed.
- `openTaskPage` records a view visit before switching view; `openAutomationsPage` does not.
- `closeTaskPage` rewinds history index when closing from a `'tasks'` history node; `closeAutomationsPage` does not.
- Keyboard history navigation already works on Automations (`Cmd/Ctrl+Alt+Arrow`), but titlebar Back/Forward is hidden there.
- `setWorktreeNavViewActivator` is currently Tasks-sentinel oriented in types/comments and must be widened for Automations.

## Goal

Make Automations a first-class entry in the existing mixed worktree/page navigation stack, matching Tasks behavior for open, back/forward traversal, close-page rewind, and titlebar controls.

## Non-goals

- Do not add persistence for navigation history; the existing stack is session-only and renderer-local.
- Do not preserve per-automation detail selection through Back/Forward beyond existing `selectedAutomationId` state.
- Do not change Activity, Settings, Space, Skills, or terminal navigation behavior.
- Do not add new shortcuts; reuse existing cross-platform `Cmd/Ctrl+Alt+Arrow` handling.

## Design

1. Add explicit view-entry type.
   - `type WorktreeNavHistoryViewEntry = 'tasks' | 'automations'`.
   - `type WorktreeNavHistoryEntry = string | WorktreeNavHistoryViewEntry`.
   - Update `recordViewVisit`, `ViewActivateFn`, and `setWorktreeNavViewActivator` signatures accordingly.
   - Update `isLiveEntry` to treat both page sentinels as live.

2. Generalize history replay branch.
   - In `navigateToIndex`, dispatch page sentinels through `viewActivator(entry)` and worktree ids through `activator(id)`.
   - Keep page replay on `setActiveView(entry)` (not `openTaskPage`/`openAutomationsPage`) to avoid mutating `previousViewBefore*` and avoid appending history during replay.
   - Keep existing index semantics: update index only after successful activation path.

3. Record and close Automations like Tasks.
   - `openAutomationsPage`: call `recordViewVisit('automations')` before switching `activeView`.
   - `closeAutomationsPage`: if current history node is `'automations'`, rewind to `findPrevLiveWorktreeHistoryIndex(state)` when available; otherwise keep index unchanged.
   - This rewind must apply regardless of close trigger (Esc / header X / any direct `closeAutomationsPage` call site).

4. Align titlebar controls with shortcut scope.
   - Show titlebar Back/Forward when `activeView` is `terminal`, `tasks`, or `automations`.
   - Keep shortcut logic unchanged; it already includes Automations.

5. Tests.
   - `worktree-nav-history.test.ts`: add Automations sentinel coverage for replay path, adjacent dedupe, dead-worktree skip, and rewind/forward behavior.
   - `ui.test.ts`: add Automations open/close history-index parity tests with Tasks, including “only automations in history” no-op rewind.
   - `App.tsx`: assert Back/Forward controls render on Automations (not optional; this is where current behavior regressed from shortcut scope).
   - `worktree-activation` wiring test coverage (or equivalent integration assertion) should verify `setWorktreeNavViewActivator` accepts/replays both sentinels.

## Known residual quirks

- Replay uses `setActiveView(...)`, so `previousViewBeforeTasks/Automations` is not recomputed on back/forward landing. Close from a replayed page can return to stale `previousViewBefore*`; this is existing Tasks behavior.
- History is capped at 50 entries. Long sessions may evict older entries, including page sentinels; this is existing behavior.
- History is renderer-local and session-local (no persistence, no cross-window reconciliation).
- Liveness is evaluated against current store state at navigation time. If a target worktree becomes invalid between target selection and activation, `activateAndRevealWorktree` may fail and index stays put.

## Edge cases

- `A -> Automations -> B`, Back lands on Automations, Back again lands on A.
- `A -> Automations -> Automations` records only one Automations entry.
- `A -> Automations`, close rewinds index to A; Forward reopens Automations.
- `Automations` as the only history entry: close leaves index at `0` (do not force `-1`, or Forward target is lost).
- If the prior worktree was deleted while Automations is open, Back/Close rewind skips it and lands on the next live prior entry.
- Back-to-Automations must not call `openAutomationsPage`, or it would overwrite `previousViewBeforeAutomations` and append duplicate history.
- Shortcut labels and handling remain cross-platform (`⌘⌥` on Mac, `Ctrl+Alt` elsewhere).
- Multi-window: each renderer has an independent history stack; no cross-window reconciliation is attempted.

## Rollout

1. Update `worktree-nav-history.ts` types, live-entry predicate, and replay branch.
2. Update `ui.ts` to record and rewind Automations visits.
3. Update `worktree-activation.ts` comments/types for generalized view activator.
4. Update `App.tsx` titlebar visibility and comments.
5. Add/adjust unit tests for history slice, UI slice, and titlebar visibility.
6. Run `worktree-nav-history.test.ts` and `ui.test.ts`, then `pnpm typecheck` and `pnpm lint`.
