# Task Provider Availability

## Problem

Provider visibility is currently driven by persisted preference, not runtime capability.

- `TaskPage` and `SidebarNav` only use `settings.visibleTaskProviders` (`normalizeVisibleTaskProviders(...)`).
- `SmartWorkspaceNameField` always renders `gitlab` and `linear` tabs from static `MODES`.
- GitLab capability exists in preflight (`window.api.preflight.check().glab?.installed`) but is only read inside `IntegrationsPane` local component state.
- Linear capability exists in store (`linearStatus.connected` / `linearStatusChecked`) but is not used as a visibility filter.

Result: unavailable providers can still appear in Tasks, Sidebar, and Create Workspace.

## Scope

- Hide unavailable providers in:
  - Tasks (`TaskPage` source icons and source resolution)
  - Sidebar (`SidebarNav` provider mini-icons)
  - Create Workspace (`SmartWorkspaceNameField` provider tabs)
- Keep `visibleTaskProviders` as user preference only.
- GitLab availability signal: `glab installed` only (not auth).
- Linear availability signal: `linearStatus.connected`.

## Non-Goals

- Do not remove GitLab/Linear integration cards from Settings.
- Do not persist runtime capability into settings.
- Do not change GitLab/Linear auth semantics.
- Do not add cross-window sync in this pass.

## Current Constraints (From Code)

- Main preflight is session-cached (`runPreflightCheck` cache in main); non-forced checks are stale until app restart or `force: true`.
- `force: true` also resets GitLab known-host cache (`_resetKnownHostsCache()`), so renderer force refresh must be preserved.
- `PreflightStatus.glab` is optional for compatibility; renderer must treat missing as unavailable.
- `checkLinearConnection()` has no in-flight dedupe today; concurrent mounts can issue duplicate status calls.
- Multi-window renderer stores are isolated; availability refresh in one window does not update others.

## Design

1. Add renderer preflight slice.
- State: `preflightStatus`, `preflightStatusChecked`, `preflightStatusLoading`, `preflightStatusError`.
- Action: `refreshPreflightStatus(options?: { force?: boolean })`.
- Implement in-slice in-flight promise dedupe for non-forced calls.
- `force: true` must bypass dedupe and always call IPC.

2. Add shared availability helper in `src/shared/task-providers.ts`.
- Keep `normalizeVisibleTaskProviders` unchanged (persistence-only normalization).
- Add availability filter:
  - Input: preferred visible providers + `{ gitlabInstalled: boolean; linearConnected: boolean }`.
  - Rules:
    - Always allow `github`.
    - Allow `gitlab` only when `gitlabInstalled`.
    - Allow `linear` only when `linearConnected`.
- If filtered list is empty, fall back to `['github']`.

3. Use availability-filtered providers in `TaskPage` and `SidebarNav`.
- Both should trigger lazy status checks when unknown:
  - preflight: `!preflightStatusChecked`
  - linear: `!linearStatusChecked`
- Availability defaults while unknown:
  - `gitlabInstalled = preflightStatus?.glab?.installed === true`
  - `linearConnected = linearStatus.connected === true`
- Feed filtered providers into source icon rendering and `resolveVisibleTaskProvider(...)`.

4. Apply same availability filter in `SmartWorkspaceNameField`.
- Replace static tab list with derived `availableModes`.
- Hide GitLab tab when unavailable.
- Hide Linear tab when unavailable.
- Trigger lazy status checks when unknown (same as Tasks/Sidebar):
  - preflight: `!preflightStatusChecked`
  - linear: `!linearStatusChecked`
- If current mode becomes unavailable:
  - switch to `smart`
  - clear source-specific rows/loading state
  - ensure no provider fetch effect fires for hidden modes.

5. Move `IntegrationsPane` to shared preflight slice.
- Replace direct `window.api.preflight.check()` mount/refresh calls with slice action.
- Keep existing status badge behavior.
- Keep refresh buttons using `force: true`.

6. Add Linear status dedupe.
- Add in-flight dedupe for `checkLinearConnection()` in Linear slice.
- Keep existing cache invalidation behavior for issue/search/list fetches unchanged.

7. Wire store shape/test helpers.
- Register preflight slice in:
  - `src/renderer/src/store/index.ts`
  - `src/renderer/src/store/types.ts`
  - `src/renderer/src/store/slices/store-test-helpers.ts`
  - `src/renderer/src/store/slices/store-session-cascades.test.ts`

## Consistency / Invalidation

- Preflight:
  - Non-forced reads may be stale.
  - `force: true` is the explicit invalidation path.
- Linear:
  - Status is eventually consistent; re-check needed after external credential mutations.
- Single window:
  - shared zustand store keeps Tasks/Sidebar/Create Workspace consistent.
- Multi-window:
  - no automatic propagation; each window requires its own refresh/check.

## Edge Cases

- Startup unknown state: treat GitLab/Linear as unavailable (GitHub remains visible).
- Older preflight payloads without `glab`: treat as unavailable.
- Persisted providers all unavailable: fall back to GitHub only.
- Availability flips while Create Workspace is open: fallback to `smart` must be immediate and idempotent.
- Remote runtime/SSH repos:
  - GitLab picker/search is already constrained in places by `selectedRepo.connectionId`.
  - This change is global provider visibility, not a per-repo capability matrix; do not overfit this pass.

## Rollout

1. Add preflight slice + tests.
2. Add provider availability helper + tests.
3. Wire `TaskPage` and `SidebarNav`.
4. Wire `SmartWorkspaceNameField` derived modes/effects.
5. Migrate `IntegrationsPane` to preflight slice.
6. Add `checkLinearConnection` in-flight dedupe.
7. Validate: missing `glab`, disconnected Linear, force refresh, multi-window staleness behavior.
