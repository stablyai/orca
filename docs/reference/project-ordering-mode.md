# Project Ordering Mode

## Problem

The sidebar can group workspaces by project, but project header order is currently coupled to workspace sorting instead of having its own user choice.

- `src/renderer/src/components/sidebar/SidebarWorkspaceOptionsMenu.tsx:59` defines one `Sort by` control for workspaces; it has no separate project-order setting.
- `src/renderer/src/store/slices/ui.ts:723` stores only `sortBy`, and `src/shared/types.ts:2543` persists the same workspace sort field.
- `src/renderer/src/components/sidebar/worktree-list-groups.ts:36` derives `ProjectGroupOrdering` from `sortBy`, so project headers follow the highest-ranked visible workspace in Recent/Smart and fall back to manual order otherwise.
- `src/renderer/src/components/sidebar/WorktreeList.tsx:3765` computes the ordered workspace ids, and `src/renderer/src/components/sidebar/WorktreeList.tsx:4060` feeds the derived project ordering into `buildRows(...)`.
- `src/renderer/src/components/sidebar/WorktreeList.tsx:826` only enables project-header drag when project grouping is manual and there are no Project Groups.
- `src/renderer/src/components/sidebar/project-header-drag.ts:1` already implements pointer-based project header dragging for virtualized rows, and `src/renderer/src/store/slices/repos.ts:699`, `src/main/ipc/repos.ts:1029`, and `src/main/persistence.ts:2497` already persist whole-repo manual reorders.

Result: users cannot choose Manual vs Recent ordering specifically for projects, the default is not Manual, and changing workspace sort can unexpectedly reorder projects.

## Goal

Add a project-only ordering preference with two modes:

- `Manual`, the default. Project headers render in the persisted manual project order, and users can drag project headers to reorder them.
- `Recent`. Project headers render by the most recent visible workspace activity in each project.

This must affect only project header order in `groupBy: 'repo'`. Worktree/workspace rows inside each project must continue to use the existing workspace `sortBy`, filtering, pinning, lineage, status, and manual-order behavior.

## Non-goals

- Do not change `sortBy` semantics or the workspace `Sort by` control.
- Do not change worktree `manualOrder`, `sortOrder`, `lastActivityAt`, or `buildWorktreeComparator(...)`.
- Do not reorder worktrees inside a project when the project ordering mode changes.
- Do not change Project Group header order; groups continue to use `ProjectGroup.tabOrder`.
- Do not add GitHub-specific behavior. Repo/project ordering must remain provider-neutral and work for GitLab, folder projects, local repos, SSH repos, and runtime environments.
- Do not add telemetry in this pass unless a later product requirement asks for it.

## Design

1. Add a persisted project-order preference.
   - Introduce `ProjectOrderBy = 'manual' | 'recent'` in `src/shared/types.ts` or a concrete sidebar ordering module.
   - Add `projectOrderBy: ProjectOrderBy` to `PersistedUIState`, defaulting to `'manual'` in `getDefaultUIState()` (`src/shared/constants.ts:387`).
   - Add `projectOrderBy` and `setProjectOrderBy` to the UI slice next to `sortBy` (`src/renderer/src/store/slices/ui.ts:723`). Like `setSortBy`, this setter is a bare `set({...})` — it does not persist on its own.
   - Persist through the debounced UI writer, not the setter. `sortBy`/`groupBy` reach disk only via the explicit field list in `App.tsx`'s `window.api.ui.set({...})` effect (`src/renderer/src/App.tsx:1019`) plus its dependency array (`src/renderer/src/App.tsx:1042`). Add `projectOrderBy` to both, or the value lives only in memory and silently resets to `'manual'` every restart.
   - Normalize persisted values in `src/main/persistence.ts` the same way `sortBy` is normalized at `src/main/persistence.ts:323`, and wire the normalizer into both `getUI()` (`src/main/persistence.ts:3116`) and `updateUI()` (`src/main/persistence.ts:3147`); invalid or missing values resolve to `'manual'`.
   - Hydration in `src/renderer/src/store/slices/ui.ts:1862` should read the normalized value without migrating existing `sortBy`.

2. Expose the choice in the sidebar options menu.
   - In `SidebarWorkspaceOptionsMenu`, keep the existing `Sort by` submenu as workspace sorting.
   - Add a second radio submenu labeled `Project order` with `Manual` and `Recent`.
   - Show it only when `groupBy === 'repo'`, because project ordering has no visible effect in `none`, `workspace-status`, or `pr-status`.
   - Use existing `DropdownMenuRadioGroup` and sidebar/menu styling from `docs/STYLEGUIDE.md`; no new tokens or custom colors.
   - Copy should make the scope clear: Manual description `Drag projects to arrange them`; Recent description `Most recent workspace activity`.

3. Decouple project header ordering from workspace sorting.
   - Replace `getProjectGroupOrdering(groupBy, sortBy)` with a project-order resolver that depends on `groupBy` and `projectOrderBy`, not workspace `sortBy`.
   - Update `buildRows(...)` so `groupBy !== 'repo'` ignores project order, `projectOrderBy === 'manual'` uses persisted manual ranks, and `projectOrderBy === 'recent'` sorts project header entries by a per-repo recent timestamp.
   - Recent must be timestamp-based, not first-encounter. Today's `'visible-worktree-order'` path (`src/renderer/src/components/sidebar/worktree-list-groups.ts:548`) works only because the caller pre-sorts the worktree array by recency when `sortBy` is `recent`/`smart`. Decoupling from `sortBy` removes that guarantee — the incoming array may be name- or manual-sorted — so the Recent resolver must explicitly compute `max(lastActivityAt)` per repo rather than relying on encounter order.
   - Recent project rank should be the maximum `lastActivityAt` among that repo's visible, unpinned worktrees passed into `buildRows(...)`. Empty placeholder projects and imported-worktree-card-only projects fall back to `Repo.addedAt`, then manual rank, then label.
   - Do not reorder `group.items`; only reorder the project header entries before `appendOrderedGroups(...)`. This preserves the existing `orderMainWorktreeFirst(...)` and workspace row ordering at `src/renderer/src/components/sidebar/worktree-list-groups.ts:632`.
   - With Project Groups, keep group headers ordered by `tabOrder`; apply Manual/Recent only to project entries within each group or the ungrouped bucket.

4. Make Manual drag/drop project-scoped (no-Project-Groups case only in v1).
   - Enable project header dragging when `groupBy === 'repo' && projectOrderBy === 'manual'`, regardless of workspace `sortBy`. Today `canReorderRepoHeaders` is additionally gated on `!hasProjectGroups` (`src/renderer/src/components/sidebar/WorktreeList.tsx:827`); the only change here is dropping the `sortBy`-derived `projectGroupOrdering` input in favor of `projectOrderBy === 'manual'`. The `!hasProjectGroups` gate stays.
   - Keep using pointer events from `project-header-drag.ts` unchanged; the virtualized-row reasoning at `src/renderer/src/components/sidebar/project-header-drag.ts:3` still applies. For the no-Project-Groups case it already does exactly what we need: a flat whole-list permutation committed through `reorderRepos(...)`, preserving current behavior and IPC rejection semantics.
   - Continue to suppress click-to-collapse only after a promoted drag, matching `src/renderer/src/components/sidebar/project-header-drag.ts:142`.
   - Defer grouped (within-Project-Group) drag to a follow-up. `useRepoHeaderDrag` is built for a single flat `orderedRepoIds` permutation: `endDrag` (`src/renderer/src/components/sidebar/project-header-drag.ts:130`) computes `fromIndex`/`insertAt` over one array and calls `onCommit` → `reorderRepos`, and `onHandlePointerDown` (`src/renderer/src/components/sidebar/project-header-drag.ts:300`) snapshots every on-screen `[data-repo-header-id]` with no notion of group boundaries. Supporting in-group reorder needs new hook logic — bucket-aware drop targets, rejecting drops outside the source sibling bucket, computing a midpoint between neighbor `projectGroupOrder` values, and a second commit mode that calls `moveProjectToGroup(projectId, sameGroupId, order)` (`src/renderer/src/store/slices/repos.ts:138`) instead of `reorderRepos`. This is its own change and is out of scope for v1.
   - In v1, Project-Groups users keep the project actions menu as the move surface (it already calls `moveProjectToGroup`). Manual project order still applies to their headers via the row-builder sort (step 3); only drag-to-reorder is unavailable inside groups.
   - Do not turn a project reorder drag into a cross-group move in any version. The existing project actions menu remains the cross-group move surface.

5. Keep persistence and runtime parity intact.
   - Local no-group manual reorder continues through `repos:reorder` (`src/main/ipc/repos.ts:1029`) and `Store.reorderRepos(...)` (`src/main/persistence.ts:2497`).
   - Remote no-group manual reorder continues through `repo.reorder` (`src/renderer/src/store/slices/repos.ts:723`).
   - Grouped manual reorder via drag is deferred (see step 4); the follow-up would route through `projectGroup.moveProject` / `moveProjectToGroup(...)`, which already handles local and runtime-environment calls. In v1, grouped projects move only through the existing actions menu.
   - The project-order preference is renderer UI state, not repo metadata. It persists through the `App.tsx` debounced `window.api.ui.set({...})` writer (step 1), not through any repo record.

6. Tests.
   - Add row-builder tests proving `projectOrderBy: 'manual'` orders project headers by `repoOrder` without changing workspace row order.
   - Add row-builder tests proving `projectOrderBy: 'recent'` orders project headers by max visible `worktree.lastActivityAt` while preserving each project's child row order.
   - Add Project Group tests for Manual and Recent within groups, plus unchanged `ProjectGroup.tabOrder`.
   - Rewrite, do not extend, the existing Recent/`getProjectGroupOrdering` tests. The current cases at `src/renderer/src/components/sidebar/worktree-list-groups.test.ts:639` ("orders repo headers by first encounter…"), `:663` ("…highest-ranked visible child"), and the `getProjectGroupOrdering` block at `:752` all assert the old first-encounter coupling and are semantically incompatible with timestamp-based Recent. Replace them with tests for the new resolver and the `max(lastActivityAt)` ordering.
   - Add UI slice/persistence normalization tests for default Manual, invalid value fallback, and hydration. Include a persistence-writer test (or note) that `projectOrderBy` is part of the `App.tsx` `ui.set` payload so it actually round-trips across restart.
   - Grouped manual drag persistence tests are deferred with the grouped-drag feature (step 4).

## Edge cases

- Existing users with no `projectOrderBy` get Manual, even if their workspace `sortBy` is Recent.
- Changing workspace `sortBy` must not change project header order unless `projectOrderBy === 'recent'` and the visible worktree set/activity data changes.
- Changing `projectOrderBy` must not mutate any worktree `manualOrder` or repo order by itself.
- Manual drag while a project is added or removed can race. Whole-repo reorder (the only v1 drag path) keeps the existing permutation rejection and refetch behavior. (Grouped midpoint writes and their refetch-on-failure handling come with the deferred grouped-drag follow-up.)
- In Recent mode, projects with no visible worktrees should still render when they are placeholders or imported-worktree-card candidates; they sort after projects with activity.
- Pinned worktrees remain in the Pinned section. They should not make their project jump in Recent ordering unless an unpinned visible workspace in that project is also recent.
- Filters and hidden sleeping/default-branch workspaces affect the visible worktree set. Recent project order should reflect the rows the user can currently see.
- Project Group collapse state must not change when the order mode changes.
- Dragging a project inside a collapsed Project Group is impossible because its repo headers are not mounted; no special handling is needed.
- Dragging across Project Group boundaries should not silently move the project; cross-group moves stay on the actions menu. (In v1 there is no in-group drag at all — see step 4 — so this only constrains the deferred grouped-drag follow-up.)
- SSH/runtime projects must use the same store actions as local projects. No local filesystem path assumptions are needed.
- Folder projects have synthetic worktrees and should participate through the same `lastActivityAt` and manual repo order paths.
- Multi-window or external mutations are last-writer-wins through existing persistence. A rejected whole-repo permutation refetches repos (existing behavior); a failed grouped move would do the same once grouped drag lands.
- Behavior change on upgrade: existing users on `sortBy: recent`/`smart` currently see project headers bubble to follow workspace activity. After this change they default to Manual project order, so headers stop bubbling until they pick Recent in the new submenu. This is intended (matches the "no `projectOrderBy` → Manual" edge case) but is a visible change worth calling out in release notes.

## Rollout

1. Add `ProjectOrderBy` types/defaults/normalization, the UI slice setter, the `App.tsx` debounced-writer field, and persistence `getUI()`/`updateUI()` wiring.
2. Add the `Project order` submenu in `SidebarWorkspaceOptionsMenu`.
3. Update `WorktreeList` to read `projectOrderBy`, pass it to row construction, and enable project drag only in Manual project order (no-Project-Groups case, keeping the `!hasProjectGroups` gate).
4. Update `worktree-list-groups.ts` to order project headers by Manual or Recent independently from workspace `sortBy`, with Recent using `max(lastActivityAt)` per repo.
5. Add focused row-builder and UI persistence/round-trip tests; rewrite the incompatible first-encounter/`getProjectGroupOrdering` tests.
6. Run targeted Vitest for sidebar row ordering and repo slice tests, then `pnpm typecheck` and `pnpm lint`.
7. Validate in Electron: default startup shows Manual project order, the choice survives restart, project drag/drop reorders project headers only (ungrouped), Recent project order follows workspace activity, and worktree rows inside each project do not change when toggling project order.

Deferred follow-up (separate change): extend `useRepoHeaderDrag` for grouped sibling buckets — bucket-aware drop targets and a second commit mode using `moveProjectToGroup(...)` midpoint ordering inside Project Groups — plus its grouped-drag persistence tests.
