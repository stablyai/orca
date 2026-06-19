# Persist Source Control Tree View Choice

## Problem or Goal

The Source Control sidebar lets the user toggle changes between list and tree views, but the choice is session-local. After remount or app restart, it falls back to list view. Persist this as a per-user setting, not per-workspace state, so a user's preferred source-control layout follows them across repos and worktrees.

## Current Behavior

- `SourceControlViewMode` is a local union in `src/renderer/src/components/right-sidebar/SourceControl.tsx:127`.
- `SourceControlInner` already reads global settings from the Zustand store at `src/renderer/src/components/right-sidebar/SourceControl.tsx:329`.
- The source-control view mode is initialized with component-local React state at `src/renderer/src/components/right-sidebar/SourceControl.tsx:486`, hard-coded to `'list'`.
- The tree/list toggle only calls `setSourceControlViewMode` at `src/renderer/src/components/right-sidebar/SourceControl.tsx:2454` and `src/renderer/src/components/right-sidebar/SourceControl.tsx:2457`.
- The chosen mode controls uncommitted entries at `src/renderer/src/components/right-sidebar/SourceControl.tsx:2859` and branch comparison entries at `src/renderer/src/components/right-sidebar/SourceControl.tsx:2967`.
- Settings are typed in `GlobalSettings` at `src/shared/types.ts:1271`, defaulted by `getDefaultSettings()` at `src/shared/constants.ts:154`, loaded with default merging at `src/main/persistence.ts:1217`, exposed through `settings:get` / `settings:set` at `src/main/ipc/settings.ts:29`, and updated in the renderer settings slice at `src/renderer/src/store/slices/settings.ts:236`.
- `PersistedUIState` exists at `src/shared/types.ts:1704`, but the request specifically asks for the user's setting rather than workspace-specific UI state.

## Proposed Design

Add a new global user setting:

```ts
sourceControlViewMode: 'list' | 'tree'
```

Implementation details:

- Add a shared `SourceControlViewMode = 'list' | 'tree'` type and the field to `GlobalSettings` in `src/shared/types.ts`.
- Add the default value to `getDefaultSettings()` in `src/shared/constants.ts`; use `'list'` to preserve existing behavior for new and upgraded users.
- Reuse the existing persistence path. `src/main/persistence.ts` already merges `defaults.settings` with `parsed.settings`, so older profiles automatically hydrate the new field without a bespoke migration.
- In `SourceControl.tsx`, stop using local `useState('list')` as the durable source of truth. Read the persisted value through a small guard such as `normalizeSourceControlViewMode(settings?.sourceControlViewMode)`, returning `'list'` for missing or invalid values.
- Keep a narrowly scoped optimistic mode in `SourceControlInner`: `optimisticSourceControlViewMode: SourceControlViewMode | null`. The rendered mode is `optimisticSourceControlViewMode ?? normalizedSettingsMode`.
- Select `updateSettings` from the store and update the toggle handler to compute the next value from the current rendered mode, set the optimistic mode immediately, and persist the next value through `updateSettings({ sourceControlViewMode: next })`.
- Track a monotonically increasing write sequence with a ref. Only the latest in-flight write may clear or revert optimistic state, so out-of-order `settings:set` responses cannot make an older click win over the user's latest intent.
- When `settings.sourceControlViewMode` changes from outside this component, clear the optimistic value if there is no newer in-flight write. This lets the authoritative settings snapshot take back over after hydration, Settings import, or another renderer path updates settings.
- Keep tree expansion/collapse state (`collapsedTreeDirs`) local and session-only. Directory expansion is path/worktree-content-specific, while the requested setting is only the global list/tree layout preference.
- Do not add a Settings pane control unless product wants one later. The existing toolbar icon remains the natural place where the user makes the choice; persisting that click is enough for this request.

The optimistic state is local UI state only; it is not a second persistence channel. It exists because `updateSettings` crosses async renderer/main IPC, and the toolbar should still behave as a normal toggle under slow writes or rapid clicks.

### Interaction and Data Flow

```text
Toolbar click
  -> derive next mode from current rendered mode
  -> optimistic SourceControlInner state updates immediately
  -> updateSettings({ sourceControlViewMode: next })
  -> settings:set persists user settings in main
  -> renderer store receives authoritative GlobalSettings
  -> SourceControlInner clears optimistic state when the latest write settles
```

- Happy path: the toolbar flips immediately, `settings:set` returns the saved settings object, and the optimistic value is cleared once the authoritative mode matches the latest requested mode.
- Missing setting: defaults merge in `'list'`; upgraded profiles do not need a migration.
- Invalid persisted value: the renderer guard treats it as `'list'` for display and for the next toggle write, which self-heals persistence on the next user action.
- Write failure: keep the previous authoritative settings object, clear only the latest optimistic value, and let the UI fall back to the last saved mode. Existing `updateSettings` logs the failure; the component does not need a new error surface for this preference toggle.
- Out-of-order writes: if write 1 sets `tree` and write 2 sets `list`, write 1 resolving after write 2 must not clear or overwrite the optimistic `list` intent in the component.

## Edge Cases

- Existing profiles with no `sourceControlViewMode` should behave exactly as before: list view.
- Settings may be `null` before hydration; render should not crash. Disable the toggle until settings hydrate so the fallback `'list'` value is never persisted over an existing saved `'tree'` preference.
- If the body renders before settings hydrate, use the guarded list fallback only as a temporary display value. Do not seed optimistic state until the real settings snapshot is available.
- Corrupt or unknown persisted values should normalize to `'list'` at the component boundary. A broader settings migration is unnecessary for this narrowly scoped string preference.
- A settings write failure should not corrupt local or persisted state. Existing `updateSettings` logs errors and leaves the previous settings object intact.
- Rapid toggles should be last-intent-wins from the user's perspective, even if individual `settings:set` IPC responses resolve out of order.
- The choice must apply globally across active worktree switches, repo switches, and local/SSH runtime targets.
- Directory collapse state should not persist globally because tree node keys are derived from file paths and sections; persisting them would leak one repo's shape into another.
- Source control can render both local and remote/SSH worktrees. This setting is renderer/user preference only and must not depend on filesystem paths, runtime target IDs, or workspace IDs.

## Test Plan

- Unit: add a focused test for `getDefaultSettings()` in `src/shared/constants.test.ts` asserting `sourceControlViewMode` defaults to `'list'`.
- Unit: add or extend a renderer test around `SourceControl` to verify clicking the tree/list toolbar calls `updateSettings({ sourceControlViewMode: 'tree' })` from the default list state, and then `updateSettings({ sourceControlViewMode: 'list' })` when currently tree.
- Unit: cover the optimistic write sequence with delayed mocked `updateSettings` promises. A rapid `list -> tree -> list` interaction should leave the rendered mode and latest requested update at `list`, even if the earlier `tree` write resolves last.
- Unit: cover `settings === null` hydration behavior: the toggle is disabled before hydration, then reflects a hydrated `'tree'` preference without persisting the fallback `'list'`.
- Unit: cover the normalization helper for invalid values, missing values, and both valid modes.
- Unit: if direct `SourceControl` rendering setup is too heavy, extract tiny pure helpers such as `getNextSourceControlViewMode(mode)` and `normalizeSourceControlViewMode(value)` near the component and test those helpers plus a shallow mocked component interaction.
- Integration-light: `src/renderer/src/store/slices/settings.test.ts` already verifies rebasing local settings to the authoritative `settings:set` response. No new store behavior is required unless implementation changes `updateSettings`.
- Manual/Electron: open Source Control, switch to tree view, switch worktrees and confirm the view remains tree, restart the app and confirm Source Control still opens in tree view, then switch back to list and confirm restart preserves list.

Playwright coverage is optional for this change. The behavior crosses app restart and local user-data persistence, which is better covered by Electron validation unless there is already a reliable e2e fixture for persistent settings across relaunch.

## Rollout Order

1. Add the `GlobalSettings` field and default.
2. Wire `SourceControl` to read a normalized `settings.sourceControlViewMode` with a safe list fallback before hydration.
3. Add optimistic last-intent-wins toggle handling and persist toolbar toggles through `updateSettings`.
4. Add focused unit coverage for the default, normalization, hydration, and async toggle writes.
5. Run `pnpm typecheck`, `pnpm lint`, targeted tests, then manual Electron validation.

## Ref-OSS

Not used. The change follows Orca's existing per-user settings pipeline and does not need external editor behavior to resolve the design.
