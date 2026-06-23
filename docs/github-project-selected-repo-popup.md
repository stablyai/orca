# GitHub Project Selected Repo Popup

## Problem

GitHub issue [#6143](https://github.com/stablyai/orca/issues/6143) reports that Tasks > GitHub > Project mode can show the `Repository not in Orca` prompt even after the user selected the intended repo in the Tasks GitHub repo selector.

Relevant code:

- [ProjectViewWrapper.tsx](/Users/jinjingliang/Documents/projects/orca/bug-is-there-a-way-to-remove-this-popup/src/renderer/src/components/github-project/ProjectViewWrapper.tsx:83) currently takes no props, builds a global `useRepoSlugIndex()`, filters rows with `filterProjectTableRowsByOpenRepos`, and resolves row actions from all slug matches.
- [ProjectViewWrapper.tsx](/Users/jinjingliang/Documents/projects/orca/bug-is-there-a-way-to-remove-this-popup/src/renderer/src/components/github-project/ProjectViewWrapper.tsx:486) opens the repo-backed detail dialog only when a row slug has exactly one global match; duplicate matches fall through to the slug dialog.
- [ProjectViewWrapper.tsx](/Users/jinjingliang/Documents/projects/orca/bug-is-there-a-way-to-remove-this-popup/src/renderer/src/components/github-project/ProjectViewWrapper.tsx:514) resolves Start Work the same way and treats zero or duplicate global matches as `repoNotInOrca`.
- [TaskPage.tsx](/Users/jinjingliang/Documents/projects/orca/bug-is-there-a-way-to-remove-this-popup/src/renderer/src/components/TaskPage.tsx:2822) owns `repoSelection` as a `ReadonlySet<string>`.
- [TaskPage.tsx](/Users/jinjingliang/Documents/projects/orca/bug-is-there-a-way-to-remove-this-popup/src/renderer/src/components/TaskPage.tsx:7765) hides the repo selector while Project mode is active, but the last Tasks repo selection remains in memory and should still scope Project mode.
- [project-row-filtering.ts](/Users/jinjingliang/Documents/projects/orca/bug-is-there-a-way-to-remove-this-popup/src/renderer/src/components/github-project/project-row-filtering.ts:13) filters only by "any open repo resolves to this slug"; it has no selected-repo concept.
- [repo-slug-index.ts](/Users/jinjingliang/Documents/projects/orca/bug-is-there-a-way-to-remove-this-popup/src/renderer/src/lib/repo-slug-index.ts:114) resolves repo slugs asynchronously per repo owner/runtime and lowercases slugs; it caches positive and null results by runtime scope plus repo id.

## Root Cause

Project mode treats the slug index as an unscoped set of all known Orca repos. Filtering, opening item details, dialog cleanup, and Start Work resolution do not intersect slug matches with the user's current Tasks repo selection. When two registered repos resolve to the same GitHub slug, selecting one of them should disambiguate the action, but the current code classifies the duplicate global match as "not in Orca."

## Non-Goals

- Do not add a second repo picker inside Project mode.
- Do not change GitHub Project fetching, server-side Project filters, pagination, or row mutation routing.
- Do not auto-clone, auto-add, or auto-select missing repos.
- Do not change GitLab, Linear, Jira, or regular GitHub Issues/PR list behavior.
- Do not change shared Dialog primitives or the GitHub Project slug/comment fetching APIs.

## Design

1. Change `ProjectViewWrapper` to accept `selectedRepoIds: ReadonlySet<string>`, and pass the existing `repoSelection` from `TaskPage`.
2. Add a small selected-repo resolver near `project-row-filtering.ts` or a focused adjacent module. Given a row, `lookupSlug`, `slugIndexReady`, and `selectedRepoIds`, it should return a classified result: loading, invalid slug, no global match, global-only/unselected matches, exactly one selected match, or multiple selected matches. Keep slug comparison delegated to `lookupSlug` so case normalization and runtime-owner handling stay centralized, and do not add per-row async work.
3. Filter visible Project rows by selected matches: a row is visible only when `row.content.repository` resolves to at least one repo whose `id` is in `selectedRepoIds`.
4. Resolve repo-backed row details and Start Work from selected matches, not global matches. Exactly one selected match uses that repo id. Multiple selected matches for the same slug are ambiguous; do not show `Repository not in Orca` and do not create a workspace from an arbitrary repo.
5. Distinguish missing from unselected:
   - slug index loading: do not resolve actions from the previous index; open the GitHub URL when available and show a short "repository list is updating" toast;
   - no global slug matches: keep the existing detail/open fallback and the `Repository not in Orca` Start Work fallback for stale actions only;
   - global matches exist but none are selected: treat the row/action as stale relative to the current Tasks selection, open the GitHub URL when available, and show a concise toast;
   - multiple selected matches: open the GitHub URL when available and show a concise toast that Orca cannot choose between selected repos.
6. Update dialog cleanup so repo-backed dialogs require a live selected repo id. Slug and missing-repo dialogs should close when the current selection would no longer allow the row action, or when the slug becomes resolvable to a selected repo-backed dialog.
7. Keep Project fetching and mutation-owner routing unchanged. Store-side `settingsForProjectRowOwner` uses the warmed slug cache for GitHub API routing and should remain scoped to row ownership, not the Tasks selection.

## Data Flow

- `TaskPage`
  - owns `repoSelection`;
  - renders `<ProjectViewWrapper selectedRepoIds={repoSelection} />`;
  - keeps the repo selector hidden in Project mode.
- `ProjectViewWrapper`
  - builds `lookupSlug` through `useRepoSlugIndex`;
  - computes selected row matches with `selectedRepoIds`;
  - filters `table.rows` by selected matches;
  - resolves row detail and Start Work actions from selected matches.
- `projectViewCacheKey`
  - remains unchanged and must not include `selectedRepoIds`; it keys the fetched GitHub Project data used by refreshes and row mutations.
- `project-visible-table-cache`
  - may include a derived `visibleCacheKey` made from `currentCacheKey` plus a sorted selected-repo fingerprint, or may clear on selection changes. Do not write selection-scoped tables into the store's GitHub Project cache.
- `launchWorkItemDirect`
  - unchanged; receives the selected repo id and keeps existing repo-owner SSH/runtime routing.

## Edge Cases

- Slug index loading: do not flash missing-repo UI. The visible-table cache must include a selected-repo fingerprint or clear on selection changes so rows from a previous selection are not shown while the index rebuilds. This is a renderer-only visible-table key, not a change to GitHub Project fetching cache keys.
- Row actions while the slug index is rebuilding: do not call `launchWorkItemDirect`, open repo-backed dialogs, or show `Repository not in Orca` from stale `lookupSlug` data. Open the GitHub URL when available and toast instead.
- Selected repo changes while a Project table is visible: recompute the visible table immediately and close repo-backed, slug, and missing-repo dialogs that no longer match the selected repo set.
- No selected repos / no eligible repos: show the existing empty table state after filtering; do not show `Repository not in Orca`.
- Repo removed while a dialog is open: keep the existing live repo guard and also require the repo id to remain selected.
- Multiple selected repos resolve to the same GitHub slug: do not show `Repository not in Orca`; do not silently create a workspace.
- Global matches exist but none are selected: do not show `Repository not in Orca`; the repo is in Orca, just outside the current Tasks selection.
- No global matches exist: preserve the missing-repo fallback for stale actions and for any future path that can invoke Start Work before filtering catches up.
- A row with no `repository` should stay filtered out, as it is today. For rows that remain visible but have no `number`, no URL, or non-issue/non-PR content, preserve the existing non-startable or open-in-browser behavior.
- SSH/runtime-owned repos: compare selected ids after `lookupSlug`; never infer selection from local paths.
- GitHub slug case differences: preserve case-insensitive matching through the existing slug index.
- External `git remote` mutations: this fix should not promise automatic re-resolution. The slug cache updates on repo/settings changes and explicit clear paths, not arbitrary remote edits in another process.
- Multi-window settings changes: this fix follows the current TaskPage's in-memory `repoSelection`. Do not add cross-window selection synchronization for this bug.

## Test Plan

- Unit: extend [project-row-filtering.test.ts](/Users/jinjingliang/Documents/projects/orca/bug-is-there-a-way-to-remove-this-popup/src/renderer/src/components/github-project/project-row-filtering.test.ts:66) for selected repo filtering:
  - keep a row when at least one slug match is selected;
  - filter a row when only unselected repos match;
  - keep a row with multiple selected matches so action resolution can report ambiguity.
- Unit: add focused row-resolution coverage for loading, invalid/missing slug, one selected match, no global match, global-only unselected match, and multiple selected matches. Assert loading does not read stale matches, and duplicate selected matches are ambiguous without `repoNotInOrca`.
- Unit: extend [project-dialog-state.test.ts](/Users/jinjingliang/Documents/projects/orca/bug-is-there-a-way-to-remove-this-popup/src/renderer/src/components/github-project/project-dialog-state.test.ts:1) so repo-backed dialogs close when the repo is no longer selected and missing/slug dialogs close on selection-scoped stale state.
- Source-boundary: update [task-page-source-switch-boundary.test.ts](/Users/jinjingliang/Documents/projects/orca/bug-is-there-a-way-to-remove-this-popup/src/renderer/src/components/task-page-source-switch-boundary.test.ts:16) to assert the Project branch renders `ProjectViewWrapper` with `selectedRepoIds={repoSelection}`.
- Cache behavior: add or extend `project-visible-table-cache` coverage so cached visible rows are not reused across selected-repo changes while `slugIndexReady` is false, and assert selection does not change the store `projectViewCacheKey`.
- Validation: run focused Vitest for the changed GitHub Project helpers and `task-page-source-switch-boundary.test.ts`, then `pnpm run typecheck` and `pnpm run lint`.

## UI Quality Bar

UI-visible, but no new layout. Project mode should keep the current table density, borders, muted surfaces, icon-only row actions, and shadcn/sonner styling from [STYLEGUIDE.md](/Users/jinjingliang/Documents/projects/orca/bug-is-there-a-way-to-remove-this-popup/docs/STYLEGUIDE.md:1). The only normal visible behavior change is that rows outside the selected Tasks repo set disappear and Start Work no longer shows a false missing-repo modal. Ambiguous or stale actions should use existing toasts with short copy and open the GitHub URL when available.

## Review Screenshots

1. Tasks > GitHub > Project mode after selecting one repo from a duplicate-slug pair: the table is scoped to the selected repo and Start Work does not show `Repository not in Orca`.
2. Project mode after switching the Tasks repo selection before entering Project mode: rows outside that selection are absent or the existing empty state is shown, with no missing-repo dialog.
3. Project mode Start Work on a selected registered repo: workspace launch path starts or falls back through the existing direct-launch fallback, not the missing-repo modal.
4. Adjacent smoke: regular Tasks > GitHub Issues/PR list still shows the repo picker and rows normally.

## Rollout

1. Add selected-repo-aware row match/resolution helpers.
2. Thread `repoSelection` from `TaskPage` to `ProjectViewWrapper`.
3. Update visible-table filtering, dialog cleanup, detail-open, and Start Work handlers to use selected matches.
4. Guard the visible-table cache against selected-repo changes during slug-index rebuilds.
5. Add focused tests and run validation.

## Lightweight Eng Review

- Scope: Correctly small. Project mode should honor the existing Tasks repo selection. No new picker, persistence model, GitHub query changes, shared Dialog edits, or provider-wide behavior changes.
- Architecture/data flow: `TaskPage` remains the owner of repo selection. `ProjectViewWrapper` remains the owner of Project row rendering/actions and receives selected repo ids as an input. Slug resolution stays in `useRepoSlugIndex`, including runtime-owner routing for SSH/runtime repos. GitHub Project mutation routing remains row-owner based and is not selection-scoped.
- Failure modes covered:
  - Slug index loading/rebuild: no missing-repo flash, and no cached rows from an old selected-repo set.
  - Selected repo changes with dialogs open: close stale repo-backed, slug, and missing-repo state.
  - Duplicate selected slug matches: avoid the false missing-repo modal and avoid arbitrary workspace creation.
  - Known-but-unselected slug matches: treat as stale/unselected, not missing.
  - Missing/invalid row repository data: preserve draft/redacted/no-slug fallbacks.
  - SSH/runtime ownership: compare selected ids after owner-routed slug lookup.
  - External remote edits and multi-window default-selection changes: acknowledged as outside this bug's consistency guarantees.
- Tests required:
  - Selected-repo row filtering.
  - Selected-repo row resolution and ambiguity.
  - Dialog cleanup under selected-repo changes.
  - TaskPage source-boundary prop threading.
  - Visible-table cache invalidation by selected-repo fingerprint.
- Performance/blast radius: No new IPC or network requests, but not "free": each render filters already-loaded Project rows and checks selected ids in a `Set`. Keep the helper O(rows + matches) with no per-row async work. Blast radius is limited to Tasks > GitHub > Project mode.
- Maintainability: Keep resolver/cache logic in focused helper modules and do not add or broaden `max-lines` disables while threading the prop through the already-large wrapper.
- UI quality bar: Maintain current Project table styling and use existing sonner toasts. Do not add a picker, inline explanation panel, or layout shift beyond rows entering/leaving the table.
- Required review screenshots: capture the duplicate-slug selected-repo fix, selected-repo row scoping/empty state, selected registered Start Work path, and adjacent regular GitHub Issues/PR smoke.
- Residual risks: Live GitHub Project validation depends on GitHub auth and suitable Project data. Row issue/PR mutations still route through the existing first warmed global slug-cache match, not the selected repo; field-value mutations route by the Project view source encoded in the cache key. That is intentionally unchanged here and should not be described as fixed by this work. If the exact duplicate-slug scenario is unavailable, document the nearest exercised state and block PR creation until a reviewer has acceptable manual evidence.
