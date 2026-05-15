# Linear AI Workspace Redesign

## Problem

The current Linear source is a list-first flow, not a workspace-first flow.

- Toolbar controls are preset chips + search (`TaskPage.tsx:2385+`).
- Connected state is a fixed table (`TaskPage.tsx:3056+`) with row-level `Use` and overflow actions.
- Detail is a right `Sheet` (`LinearItemDrawer.tsx`) capped at `sm:max-w-[640px]`, with `Start workspace` in the footer.

This makes “start work in Orca” a secondary action instead of the main path.

## Ground Truth Constraints (from code)

1. Must keep existing Linear runtime calls.
- List/search: `listLinearIssues`, `searchLinearIssues`.
- Detail/comments: `linearGetIssue`, `linearIssueComments`.
- Mutations: `linearUpdateIssue`, `linearAddIssueComment`, `linearCreateIssue`.
- Store cache + optimistic propagation: `patchLinearIssue` in `linear` slice.

2. Must keep existing workspace launch path.
- `handleUseLinearItem` -> `openComposerForLinearItem` -> `openModal('new-workspace-composer', { linkedWorkItem, ... })`.
- No direct agent orchestration UI in this feature.

3. Existing behavior to preserve.
- Team filtering is client-side from `linearIssues` (`filteredLinearIssues`).
- Search/list fetches are debounced via local `appliedLinearSearch` and refresh nonce.
- Cache TTL is 60s in `linear` slice; requests are deduped per cache key.

## Corrections To Prior Assumptions

1. Grouping/sorting is not implemented today.
- Current list renders `filteredLinearIssues` in returned order.
- No grouping by `state.name` and no local `updatedAt` sort currently exists.

2. Comments failure handling is weak today.
- Issue and comments fetches are independent (good), but comments errors are swallowed.
- There is no retryable comments error state in `LinearItemDrawer`.

3. “Activity” is not available as a first-class API payload in current renderer types.
- `LinearIssue` shape has no activity stream fields; only basic fields (`updatedAt`, etc.).
- Full activity timeline cannot be claimed “for free” with current contracts.

4. One-call claims are unsafe.
- Full issue + comments + metadata controls are multiple calls and multiple caches.
- Treat them as separate async surfaces.

## Design

1. Replace Linear table surface in `TaskPage` with a two-pane workspace layout.
- Left pane: existing controls (workspace selector, teams, presets, search) + issue list.
- Right/main pane: inline issue workspace for selected issue.
- Keep `LinearItemDrawer` only as temporary fallback during migration, not the primary UX.

2. List behavior.
- Keep API-returned order as default unless explicit product decision adds deterministic local sort.
- If local sort is added, define tie-breakers and keep stable ordering to avoid row jumping during optimistic patches.
- Keep row metadata lightweight: identifier, title, team/workspace context, state, priority, assignee, relative `updatedAt`.

3. Detail behavior.
- Header: identifier, title, team/workspace, updated time, open in Linear.
- Properties: reuse existing mutation controls and optimistic patch logic (status/priority/assignee/labels).
- Body/comments: render description and comments; show explicit comments error + retry action.
- Actions: Start workspace (existing composer), Copy URL, Copy identifier, Copy branch-name suggestion, Copy prompt.

4. CLI-agent bridge stays narrow.
- Start action must keep calling `handleUseLinearItem`.
- Copy actions are convenience only; no in-app chat/transcript/agent execution wrapper.

5. Data consistency rules.
- Keep `linear` slice as source of truth for cache mutation propagation.
- Do not introduce a second Linear cache in component state beyond view-local selection/UI state.
- If keeping local `linearIssues` array in `TaskPage`, it must be reconciled when cache patches or refreshes land, or replaced by store-driven selectors.

## Required Edge Cases

1. Connection/workspace.
- Disconnected state remains current connect flow.
- Workspace switch clears stale issue selection and team-derived controls immediately.
- `selectedWorkspaceId='all'` must preserve workspace context on actions/mutations.

2. Selection lifecycle.
- If selected issue disappears from filtered set after search/preset/team/workspace change, clear selection deterministically.
- Do not auto-select a new issue if user explicitly closed details in this session.

3. Concurrency and external mutation.
- Multi-window: optimistic patch in one window will not instantly update others; UI must tolerate stale rows until refresh/TTL.
- External Linear edits (web/other client): stale local issue state is expected up to cache TTL unless explicit refresh/reopen happens.
- In-flight response ordering: keep request-id guards (as in drawer) for detail/comments to prevent stale overwrite.

4. Error isolation.
- Detail success + comments failure must still render detail.
- Mutation failure must revert optimistic state and surface toast (existing behavior).
- Comments submit failure must preserve draft text.

5. Platform/SSH.
- New keyboard handling must remain Cmd/Ctrl compatible (current comment submit checks both).
- Launch path must remain runtime/composer-based; no local-only assumptions.

## Rollout

1. Implement two-pane layout behind `taskSource === 'linear'` using existing tokens/primitives from `docs/STYLEGUIDE.md`.
2. Reuse existing mutation + launcher handlers; move them into inline detail surface.
3. Add explicit comments error state with retry.
4. Validate with:
- Connected/disconnected flow.
- Workspace/team/search/preset transitions.
- Optimistic mutation + revert paths.
- External change staleness (manual refresh behavior).
- Narrow-width behavior (list/detail navigation).

## Out of Scope

1. New backend sync service or local Linear replica.
2. AI GUI wrapper around agent execution.
3. Broad task-source redesign beyond Linear surface.
