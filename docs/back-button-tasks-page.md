# Back/Forward support for the Tasks page

## Goal

Make the titlebar back/forward buttons and the `Cmd/Ctrl+Alt+←/→` shortcut
traverse Tasks visits in addition to worktree activations. Today both are
no-ops outside `activeView === 'terminal'` (see `App.tsx:616`, `App.tsx:900`).

## Current shape

- History lives in `src/renderer/src/store/slices/worktree-nav-history.ts`.
- Entries are `string[]` (worktree IDs), recorded from
  `worktree-activation.ts:96` via `recordWorktreeVisit`.
- `goBackWorktree`/`goForwardWorktree` skip dead worktrees via
  `findPrev/NextLiveWorktreeHistoryIndex`, gated by an `activator` ref and
  `isNavigatingHistory` to prevent re-recording.
- UI (pre-change): titlebar buttons hidden unless
  `activeView === 'terminal'`; shortcut ignored outside terminal view.

## Minimal implementation (downscoped)

1. **History entry type** → `string | 'tasks'`.
   - `findPrev/NextLiveWorktreeHistoryIndex` must short-circuit on `'tasks'`
     before calling `findWorktreeById` (which takes a worktree id, not a
     view tag) — Tasks entries are unconditionally live.
   - Keep `recordWorktreeVisit(worktreeId: string)` signature to avoid churn
     in `terminals-hydration.test.ts`. Add a sibling
     `recordViewVisit(entry: 'tasks')` that shares the dedupe/truncate/cap
     logic.
   - Keep existing names (`worktreeNavHistory`, `goBackWorktree`,
     `canGoBackWorktreeHistory`). They're now slight misnomers since
     entries may be `'tasks'`, but renaming touches ~20 call sites for no
     behavioral win. Add a one-line comment at the top of the slice
     stating the entry type and the intentional keeping of the name, so
     future readers don't assume it's worktree-only.

2. **Record Tasks visits** → call `recordViewVisit('tasks')` from
   `openTaskPage` (`ui.ts:189`). No `isNavigatingHistory` guard needed:
   back-to-Tasks routes through `setActiveView('tasks')` per step 3, which
   never touches `openTaskPage`. The slice's existing adjacent-entry dedupe
   covers any other re-entry. Note: `openTaskPage` is called with varying
   `taskPageData` (e.g. `{ taskSource: 'github' }` vs `'linear'` from
   `SidebarNav.tsx:88,102`); all collapse to a single `'tasks'` entry and
   dedupe against the current entry, so toggling presets produces no extra
   history entries. This is consistent with the out-of-scope "no per-entry
   snapshotting" decision.

3. **Dispatch in goBack/goForward** → based on entry kind:
   - worktreeId → existing `activator(worktreeId)` path. When current entry
     is `'tasks'`, no extra view handling is needed:
     `activateAndRevealWorktree` at `worktree-activation.ts:82-84` already
     switches `activeView` back to `'terminal'`.
   - `'tasks'` → `setActiveView('tasks')` (not `openTaskPage` — avoids
     mutating `previousViewBeforeTasks` and the SWR prefetch).

4. **Fix Esc-close history desync.** `closeTaskPage` (`ui.ts:210`) currently
   sets `activeView` to `previousViewBeforeTasks` without touching the
   history index, so after `A → Tasks → Esc` the index still points at the
   `'tasks'` entry and Back becomes a visual no-op (activator re-activates A)
   while Forward re-opens Tasks. Fix: in `closeTaskPage`, if the current
   history entry is `'tasks'`, move the index to the previous live entry
   (same scan as `findPrevLiveWorktreeHistoryIndex`). Sub-case: if there is
   no previous live entry (e.g. user's first action was open Tasks, then
   Esc — history `['tasks']` at index 0), leave the index unchanged at 0.
   Accept the minor cost (Back becomes a visual no-op until a real visit
   records a new entry) rather than setting to -1, which would lose the
   only forward target. Guard with `isNavigatingHistory` is unnecessary
   here — `closeTaskPage` is never invoked from the history path.

5. **Unhide UI on Tasks** (allowlist, not denylist — `activeView` union is
   `'terminal' | 'settings' | 'tasks'`, but an allowlist won't silently
   include future views):
   - Replace the `activeView !== 'terminal'` early-return at `App.tsx:616`
     with `activeView !== 'terminal' && activeView !== 'tasks'`. Update the
     adjacent comment (`App.tsx:613-615`) — it currently claims the
     shortcut is a no-op outside terminal because the buttons are hidden;
     replace with: back/forward traverse worktree + Tasks visits, so the
     shortcut is active whenever the button cluster is (terminal or
     Tasks); still suppressed elsewhere (Settings).
   - Change the titlebar cluster guard at `App.tsx:900` to
     `activeView === 'terminal' || activeView === 'tasks'`. Update the
     adjacent comment (`App.tsx:896-899`) — drop the "terminal view only"
     framing; explain the cluster is shown wherever the history shortcut
     is live, and hidden in Settings to keep that view modal-ish.

6. **Tests**: extend `worktree-nav-history.test.ts` for mixed entries:
   - `A → Tasks → B`, back lands on Tasks, back again on A.
   - Tasks dedupe against current entry.
   - Dead worktree between Tasks entries is skipped.
   - `A → Tasks → closeTaskPage()`: index moves back to A; subsequent Back
     is a no-op, Forward re-opens Tasks.
   - `Tasks (only entry) → closeTaskPage()`: index stays at 0, Back is a
     visual no-op.

## Explicitly out of scope

- **Settings in history.** Stays modal-ish; closes via
  `previousViewBeforeSettings`.
- **Per-entry `taskPageData` snapshotting.** Back-to-Tasks opens Tasks with
  default filters/source. Revisit if users complain.
- **Session persistence of history.** Keep in-memory only (it already is).

## Edge cases handled

- Worktree deletion mid-session → skipped by existing live-check; Tasks
  entries always live.
- Dedupe semantics → same adjacency rule works for `'tasks'`.
- Activator failure on worktree → unchanged (`result !== false` gate). Tasks
  dispatch can't fail.
- Editable-target guard at `App.tsx:600` still fires first → typing in the
  Tasks search box + `Cmd+Alt+←` remains a no-op.
- `MAX_HISTORY = 50` → Tasks entries consume slots; worst-case effective
  worktree depth halves to ~25. Acceptable.

## Known residual quirks (accepted)

1. **Prefetch loss on back-to-Tasks.** Routing through `setActiveView('tasks')`
   skips the SWR prefetch at `ui.ts:201-208`; back-to-Tasks is ~300–800ms
   slower than a fresh open via the sidebar. Not a regression vs today
   (back-to-Tasks isn't possible at all today).

2. **Titlebar layout shift.** Revealing the button cluster on Tasks changes
   the titlebar — needs a visual check that nothing Tasks-specific collides.

## Files touched

- `src/renderer/src/store/slices/worktree-nav-history.ts` — entry type,
  `recordViewVisit`, dispatch in `goBack/goForwardWorktree`.
- `src/renderer/src/store/slices/worktree-nav-history.test.ts` — new cases.
- `src/renderer/src/store/slices/ui.ts` — `openTaskPage` records via
  `recordViewVisit`; `closeTaskPage` rewinds history index when the current
  entry is `'tasks'`.
- `src/renderer/src/App.tsx` — widen the two `activeView === 'terminal'`
  guards to include `'tasks'`, and update the adjacent "why" comments at
  `App.tsx:613-615` and `App.tsx:896-899` to reflect the new invariant.

Estimated diff: ~30 lines of slice logic, 1 call site in `ui.ts`, 2 guards
in `App.tsx`, plus tests.
