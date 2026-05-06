# Tasks Page Resume State

## Goal

When a user leaves the Tasks page and comes back later, Orca should reopen the page in the same working context instead of falling back to a generic GitHub Issues/PRs list.

The resume behavior should cover:

- GitHub vs Linear.
- GitHub Issues/PRs vs GitHub Project mode.
- The selected GitHub Issues/PRs preset or custom search.
- The selected GitHub Project and Project view.
- The selected repos for GitHub Issues/PRs.
- The selected Linear teams.

This should be lightweight. It should not introduce a second project-selection model or duplicate state that is already persisted elsewhere.

## Existing Persisted State

The current settings model already remembers most durable task choices:

- `settings.defaultTaskSource` remembers GitHub vs Linear.
- `settings.defaultRepoSelection` remembers GitHub repo selection for cross-repo Issues/PRs.
- `settings.defaultLinearTeamSelection` remembers Linear team selection.
- `settings.githubProjects.activeProject` remembers the active GitHub Project.
- `settings.githubProjects.lastViewByProject` remembers the last selected Project view per Project.
- `settings.defaultTaskViewPreset` remembers the user's default GitHub Issues/PRs preset.

These should stay in place. They are already wired into the page and, for repo/team/project selection, they represent actual user preferences rather than purely transient page state.

## Missing State

The missing piece is the user's current page position inside Tasks:

- Whether GitHub is showing `Issues/PRs` or `Project`.
- Which GitHub Issues/PRs preset is currently active.
- The currently applied GitHub Issues/PRs query when the user has typed a custom search.
- Which Linear preset is currently active.
- The currently applied Linear query when the user has typed a search.

Linear presets are visible task tabs and drive the fetch path, so they must be restored too.

## Proposed Shape

Add a small optional field to `PersistedUIState`:

```ts
export type TaskResumeState = {
  githubMode?: 'items' | 'project'
  githubItemsPreset?: TaskViewPresetId | null
  githubItemsQuery?: string
  linearPreset?: 'assigned' | 'created' | 'all' | 'completed'
  linearQuery?: string
}
```

Then add:

```ts
taskResumeState?: TaskResumeState
```

to `PersistedUIState`.

Why `PersistedUIState`: this is page-position UI state, similar to sidebar filters and widths. It is not an app-wide setting and should not be presented as a configurable default.

Do not add `source` to `TaskResumeState`. `settings.defaultTaskSource` already represents the user's last-used task source today, and duplicating it would create two persisted sources of truth. Keep source changes on the existing settings path.

Do not reset `githubMode` just because the current source is Linear. Source selection and GitHub sub-mode are independent pieces of context: if the user was in GitHub Project mode, switched to Linear, then later switches back to GitHub, GitHub should still reopen in Project mode.

## Restore Rules

On Tasks page mount:

1. If `taskPageData.taskSource` was passed by a caller, use it. Explicit navigation intent should win.
2. Otherwise fall back to `settings.defaultTaskSource`.
3. Apply these restore rules only after both settings and persisted UI state have hydrated. The current app loads those asynchronously before setting `persistedUIReady`; a `useState` initializer that reads `settings === null` or an unhydrated `taskResumeState` will capture defaults and miss the restored context.

The restore should run once per Tasks page mount, after hydration is ready. It should not keep reapplying persisted state over local user interactions while the page remains open.

For GitHub:

1. Restore `githubMode` from `taskResumeState.githubMode`.
2. If mode is `items`, restore `githubItemsPreset` and `githubItemsQuery`.
3. Repo selection continues to come from `settings.defaultRepoSelection`.
4. If mode is `project`, use `settings.githubProjects.activeProject` and `settings.githubProjects.lastViewByProject`.
5. If Project mode has no active project or view, show the Project picker empty state instead of silently switching to Issues/PRs.

For Linear:

1. Restore `linearPreset`.
2. Restore `linearQuery`.
3. Team selection continues to come from `settings.defaultLinearTeamSelection`.

Fallback behavior:

- If resume state is absent, use today's defaults.
- If `githubItemsPreset` is non-null, derive the query from the preset unless `githubItemsQuery` disagrees because of a future migration. The preset should be treated as authoritative.
- If `githubItemsPreset` is null, use `githubItemsQuery` as a custom search.
- If `linearQuery` is non-empty, treat it as custom search and keep the restored `linearPreset` as the preset to return to after the search is cleared. The visible active preset should be suppressed while the search input is non-empty, matching today's UI.

## Write Rules

Update `taskResumeState` only when the user changes the active page context:

- Switching GitHub mode between Issues/PRs and Project.
- Clicking a GitHub Issues/PRs preset.
- Applying the debounced GitHub Issues/PRs search.
- Clearing the GitHub Issues/PRs search.
- Clicking a Linear preset.
- Applying the debounced Linear search.
- Clearing the Linear search.

Do not persist every raw search keystroke. The current UI applies search after a 300 ms debounce, so the persisted value should follow the debounced applied query, not the raw input. A user who types, waits for results, leaves Tasks, and comes back should see the same applied query.

Task source, repo selection, Linear team selection, active Project, and active Project view should continue writing through their existing settings paths.

The resume setter should merge partial updates with the existing resume state so changing one dimension does not erase the others. It should persist via `window.api.ui.set({ taskResumeState })` after updating local Zustand state.

When writing preset selections, clear stale custom-query ambiguity explicitly:

- GitHub preset click: write `{ githubItemsPreset: presetId, githubItemsQuery: undefined }` or the canonical preset query. Restore must still use the preset as authoritative.
- GitHub custom search apply/debounce: write `{ githubItemsPreset: null, githubItemsQuery: trimmedQuery }`.
- GitHub search clear: write `{ githubItemsPreset: null, githubItemsQuery: '' }`.
- Linear preset click: write `{ linearPreset: presetId, linearQuery: '' }`.
- Linear custom search apply/debounce: write `{ linearQuery: trimmedQuery }` without changing `linearPreset`.
- Linear search clear: write `{ linearQuery: '' }` without changing `linearPreset`.

Do not persist mode changes caused only by hiding Project mode while another source is active. In practice, avoid an effect that changes persisted `githubMode` from `project` to `items` when `taskSource !== 'github'`.

## Implementation Notes

Primary files:

- `src/shared/types.ts`: add `TaskResumeState` and `taskResumeState?: TaskResumeState`.
- `src/shared/constants.ts`: no required default beyond leaving the field absent. If a concrete default is preferred, use GitHub Issues/PRs with the existing default preset.
- `src/renderer/src/store/slices/ui.ts`: hydrate `taskResumeState` defensively, expose a setter such as `setTaskResumeState`, and use it in `openTaskPage` prefetch selection.
- `src/renderer/src/components/TaskPage.tsx`: initialize source from existing settings/page data, and initialize GitHub mode, GitHub item preset/query, Linear preset, and Linear query from the resume state.
- `src/renderer/src/App.tsx`: no new work should be needed if the field rides the existing `ui:get` hydration.

The setter should call `window.api.ui.set({ taskResumeState })` through the same persistence path used by other persisted UI fields, or follow the existing store pattern if there is already a central UI save effect for the relevant slice.

Hydration must sanitize the nested object because `PersistedUIState` comes from disk. Invalid `githubMode`, invalid GitHub preset ids, invalid Linear preset ids, or non-string queries should fall back field-by-field rather than entering Zustand as untrusted values.

`TaskPage` should subscribe to `persistedUIReady`, `settings`, and `taskResumeState`, then perform a one-shot local initialization once both settings and UI hydration are available. This avoids the current class of bugs where `useState(settings?.defaultTaskViewPreset ?? 'all')` captures `'all'` before settings arrive.

`openTaskPage` currently prefetches the settings default GitHub preset. After this change, it should prefetch the query the Tasks page will actually mount with:

1. If explicit `taskPageData.taskSource` is `linear`, skip GitHub prefetch.
2. If explicit `taskPageData.taskSource` is `github`, or the resolved source is GitHub, prefetch only when the resolved GitHub mode is `items`.
3. If `githubItemsPreset` is non-null, prefetch that preset query.
4. If `githubItemsPreset` is null and `githubItemsQuery` is non-empty, prefetch the custom query.
5. Otherwise prefetch `settings.defaultTaskViewPreset`.

The prefetch should also use the same repo selection the page will use: `taskPageData.preselectedRepoId` when present, otherwise `settings.defaultRepoSelection`, otherwise all eligible repos. Warming only `activeRepoId` is acceptable as an optimization fallback, but it is not equivalent to the mounted cross-repo query.

## Non-Goals

Do not remember scroll position, selected table row, open dialogs, pagination page, Project search overrides, or cached API results in this pass.

Those states are more fragile because they depend on live remote data. The first version should only restore the user's broad working context.

## Acceptance Criteria

- Open Tasks, switch to Linear, leave Tasks, return to Tasks: Linear is selected.
- Open Tasks, switch to GitHub Project mode, switch to Linear, leave Tasks, return to Tasks, then switch back to GitHub: GitHub is still in Project mode.
- Open Tasks, switch to GitHub Project mode, select a Project view, leave Tasks, return to Tasks: Project mode opens on the same Project view.
- Open Tasks, choose GitHub Issues/PRs `My PRs`, leave Tasks, return to Tasks: GitHub Issues/PRs opens with `My PRs` active.
- Open Tasks, type and apply a custom GitHub search, leave Tasks, return to Tasks: GitHub Issues/PRs opens with that custom query and no preset selected.
- Open Tasks, type a GitHub search, wait for the debounced results, leave Tasks, return to Tasks: GitHub Issues/PRs opens with that applied query and no preset selected.
- Open Tasks, choose Linear `Completed`, leave Tasks, return to Tasks: Linear opens with `Completed` active.
- Open Tasks, type a Linear search, wait for the debounced results, leave Tasks, return to Tasks: Linear opens with that applied query.
- Open Tasks before hydration has completed, then wait for hydration: Tasks applies the persisted source/mode/preset/query exactly once and does not overwrite subsequent user changes.
- Corrupt `taskResumeState` on disk with invalid modes/preset ids/non-string queries, restart, and open Tasks: invalid fields are ignored field-by-field without breaking the page.
- Existing repo selection, Linear team selection, and GitHub Project view persistence keep working unchanged.
- Restart the app after each source/mode/preset/custom-query scenario above: the same Tasks context is restored from persisted UI/settings state.
