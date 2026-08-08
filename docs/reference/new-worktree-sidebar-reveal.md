# New Worktree Sidebar Reveal

## Problem

Issue https://github.com/stablyai/orca-internal/issues/350 asks that newly created worktrees jump into view in the left sidebar list with no scroll animation.

Current behavior:

- `activateAndRevealWorktree(...)` always calls `state.revealWorktreeInSidebar(worktreeId)` with no options.
- `revealWorktreeInSidebar` defaults `behavior` to `'smooth'` (`ui.ts`).
- `WorktreeList` forwards that behavior to `virtualizer.scrollToIndex(..., { behavior })`.

Result: off-screen targets animate by default, including freshly created worktrees.

## Root Cause

`activateAndRevealWorktree` conflates two intents:

1. activate existing worktree navigation (smooth reveal is fine);
2. activate a just-created worktree (must jump immediately).

Created-worktree callers cannot currently express reveal intent, so they inherit `'smooth'`.

## Scope and Non-goals

- Add an opt-in reveal behavior at activation call sites.
- Apply `'auto'` only where the worktree is newly created/added in that flow.
- Preserve existing behavior for normal worktree navigation (clicks, keyboard, history nav, palette selection of existing worktrees, port/status-driven activation) unless a caller opts in.
- Do not change direct raw reveal paths in IPC handlers that intentionally call `store.revealWorktreeInSidebar(...)` outside `activateAndRevealWorktree` (terminal/editor/mobile focus paths remain smooth).
- Do not change sorting/grouping/filter UI, list virtualization strategy, or sidebar styling.

## Design

1. Extend `activateAndRevealWorktree` options:
   - `sidebarRevealBehavior?: PendingSidebarWorktreeReveal['behavior']`.
2. In `activateAndRevealWorktree`, call:
   - `state.revealWorktreeInSidebar(worktreeId, { behavior: opts.sidebarRevealBehavior })` when provided;
   - otherwise keep `state.revealWorktreeInSidebar(worktreeId)` so default behavior stays unchanged.
3. Pass `sidebarRevealBehavior: 'auto'` only from created/added-worktree flows:
   - `useComposerState` full-create path;
   - `useComposerState` quick-create path;
   - `useIpcEvents` `onActivateWorktree` only when the event corresponds to a newly created worktree;
   - `launch-work-item-direct`;
   - folder add/create flows that activate a newly-added synthetic folder worktree (`AddRepoCreateStep` folder branch, `NonGitFolderDialog`, and `repos` slice `addNonGitFolder` path).
4. Keep existing navigation activations smooth, including:
   - `AddRepoDialog` / `ProjectAddedDialog` “open primary worktree” actions (these can target pre-existing worktrees, not guaranteed newly created);
   - all existing `activateAndRevealWorktree(...)` callers that do not opt in.
5. Keep `WorktreeList` reveal effect unchanged; it already honors `pendingRevealWorktree.behavior`.

## Correctness Notes and Edge Cases

- Repo-filter clearing remains unchanged: `activateAndRevealWorktree` only clears `filterRepoIds` when target repo is excluded.
- Other visibility constraints are not auto-cleared. If the target exists but is hidden by other sidebar state, `resolvePendingSidebarReveal(...)` keeps the reveal pending.
- The reveal effect uncollapses lineage/group containers before scroll; behavior changes only animation mode, not visibility resolution.
- Pending reveal is a single store slot (`pendingRevealWorktree`). Concurrent reveal requests are last-writer-wins; this change should not alter that behavior.
- If activation cannot resolve the worktree (`getKnownWorktreeById` miss), behavior remains unchanged (`false`, no reveal queued).
- `ui:activateWorktree` is an overloaded IPC used by both creation and non-creation activation paths. The renderer must choose `'auto'` only for create cases (for example, worktree absent before fetch and present after fetch), and keep default smooth reveal for existing-worktree activations.
- Multi-window consistency remains per renderer window store; each window applies its own reveal behavior locally.
- This change is renderer-only; it does not add main-process coordination and does not make reveal ordering transactional across concurrent async creators.

## Tests

Add/adjust focused tests in `worktree-activation` coverage:

- explicit `sidebarRevealBehavior: 'auto'` is forwarded to `revealWorktreeInSidebar(worktreeId, { behavior: 'auto' })`;
- no option still calls `revealWorktreeInSidebar(worktreeId)` (store default remains smooth).

Add call-site regression tests (recommended, small):

- one composer create path passes `'auto'`;
- one non-created navigation path stays default (no behavior option).

## Rollout

1. Add `sidebarRevealBehavior` option in `activateAndRevealWorktree`.
2. Update created-worktree callers to pass `'auto'`.
3. Add tests above.
4. Run targeted Vitest tests, then `pnpm typecheck` and `pnpm lint`.
5. Validate in Electron: with sidebar overflow, create a worktree and verify the list jumps to it without smooth animation.
