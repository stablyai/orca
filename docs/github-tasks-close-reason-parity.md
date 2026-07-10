# GitHub Tasks Close Reason Parity

## Problem

- [TaskPage.tsx](/Users/jinwoohong/orca/workspaces/orca/tasks-page-parity/src/renderer/src/components/TaskPage.tsx:1025) renders `GHStatusCell` with only `Open` and `Closed`.
- [TaskPage.tsx](/Users/jinwoohong/orca/workspaces/orca/tasks-page-parity/src/renderer/src/components/TaskPage.tsx:1064) sends `{ state: 'closed' }`, so the list path cannot choose GitHub close reasons.
- [TaskPage.tsx](/Users/jinwoohong/orca/workspaces/orca/tasks-page-parity/src/renderer/src/components/TaskPage.tsx:1137) styles closed issues with rose/destructive color, while GitHub treats closing as a neutral/purple completion action rather than a delete/error action.
- [GitHubItemDialog.tsx](/Users/jinwoohong/orca/workspaces/orca/tasks-page-parity/src/renderer/src/components/GitHubItemDialog.tsx:4960) has a separate issue-detail status popover; it must expose the same close reasons so opening an issue from Tasks does not fall back to the old Open/Closed-only UI.
- [GitHubIssueCommentComposer.tsx](/Users/jinwoohong/orca/workspaces/orca/tasks-page-parity/src/renderer/src/components/github/GitHubIssueCommentComposer.tsx:188) already supports close reasons in the detail composer, but the Tasks list does not.

## Goal

Bring the GitHub Tasks list status menu closer to GitHub:

1. Closed issue UI must stop using destructive red styling.
2. Open issues must expose close-as-completed, close-as-not-planned, and close-as-duplicate from the status menu.
3. Duplicate closes must require a target issue number and pass it as `duplicateOf`.
4. Reopening still works from the same status menu.
5. GitHub issue detail metadata must use the same close-reason and duplicate-picker behavior as the Tasks row.

## Non-goals

- No provider-generic changes for GitLab, Linear, or Jira.
- No network-backed GitHub issue search picker in this pass; the duplicate picker uses the loaded Tasks cache plus an exact issue-number fallback.
- No schema changes or cache migration.
- No change to PR status behavior.
- No automatic cross-window broadcast beyond the existing cache/list refresh mechanics; this pass updates the current renderer optimistically and relies on normal refetch in other windows.

## Design

1. Add a small TaskPage GitHub status menu model in a named module, including option metadata, duplicate-target validation, and payload construction for close reasons.
2. Update `GHStatusCell` so `handleStateChange` accepts close options, optimistically patches only the issue `state`, and sends `stateReason` plus optional `duplicateOf`.
3. Route issue-state mutations by issue identity:
   - If the row URL parses to `owner/repo`, use `github.project.updateIssueBySlug` / runtime `github.project.updateIssueBySlug`. This avoids closing the wrong repository for GitHub project/custom-source rows whose issue repo can differ from the caller repo.
   - Otherwise keep the existing `github.updateIssue` path with `repoPath`/`repoId`/`sourceContext`.
4. Render the status popover with `Open`, `Close as completed`, `Close as not planned`, and `Close as duplicate` in both the Tasks row and issue-detail metadata sidebar. The duplicate row advances to a second-step picker with a back button, search field, loaded issue candidates, and an exact-number fallback.
5. Replace rose closed-state classes with token-based primary/ring color-mix classes so the closed pill is completion-like, not destructive. Keep the open-state green treatment for parity with the existing Tasks page unless a broader status-color pass changes it.
6. Keep the payload serializable for IPC/runtime/SSH: `{ state, stateReason, duplicateOf }` only contains strings and numbers.

## API Notes

- The local path in [issues.ts](/Users/jinwoohong/orca/workspaces/orca/tasks-page-parity/src/main/github/issues.ts:231) already closes issues with `gh issue close`. Preserve that model and pass:
  - `--reason completed` for `stateReason: 'completed'`
  - `--reason "not planned"` for `stateReason: 'not_planned'`
  - `--duplicate-of <number>` for `stateReason: 'duplicate'` with `duplicateOf`
- The slug path in [mutations.ts](/Users/jinwoohong/orca/workspaces/orca/tasks-page-parity/src/main/github/project-view/mutations.ts:160) must not implement duplicates by PATCHing `duplicate_of` on `repos/{owner}/{repo}/issues/{n}`. `gh issue close --duplicate-of` is the supported CLI surface already used by the path-based mutation, so slug-addressed state changes should use `gh issue close/reopen --repo owner/repo` for state and reserve REST PATCH for title/body.
- When `stateReason: 'duplicate'` is sent without a valid `duplicateOf`, reject it before dispatch. Do not silently downgrade to plain closed or `--reason duplicate`, because GitHub's duplicate UX expects the target issue to be recorded.
- Keep `state_reason` REST PATCH only for non-duplicate close reasons if the implementation deliberately stays on REST for completed/not-planned. The simpler consistency target is to route all slug-addressed state changes through `gh issue close/reopen`.

## Data Flow

- User opens a GitHub issue status pill.
- Completed/not-planned click -> `handleStateChange('closed', { stateReason })`.
- Duplicate click -> second-step picker -> select a loaded issue or exact target number -> `handleStateChange('closed', { stateReason: 'duplicate', duplicateOf })`.
- Cell optimistically patches local state and store row state.
- Mutation goes through local IPC or runtime RPC with the same repo/source context.
- Failure reverts the local/store state and shows the existing error toast.
- Success records the existing `github-tasks` feature interaction and should invalidate or refresh the relevant work-items cache entry if the current filter can hide the row after the state changes (for example, an `is:open` filter). Without that, a closed row can remain visible until a later refetch.

## Edge Cases

- Duplicate target is blank, zero, negative, decimal, or the same issue number: keep the picker open and show inline validation after Enter.
- Duplicate target can be a different repository's issue only when the implementation accepts a URL; this pass takes a loaded same-repository issue or number, so validation and copy should describe it as an issue in the same repository.
- The row refreshes while the menu is open: reconcile the optimistic draft before paint as the current status cell already does.
- Rapid repeated choices: retain the existing request id guard so stale responses cannot revert a newer choice.
- SSH/runtime target: payload must remain serializable and use the existing runtime method.
- Multi-window consistency: do not assume another window's in-memory `workItemsCache` observes the optimistic patch. Ensure the mutation path updates GitHub authoritatively and that normal cache invalidation/refetch behavior eventually corrects other windows.
- Project/custom-source rows: prefer the parsed issue URL slug over the selected local repo when available, because a GitHub Project can contain issues from repositories other than the current worktree.
- PR rows and rows without a repo continue to render a non-editable status pill.
- Rows without a parsed slug and without a local repo/source context should stay non-editable; do not attempt a mutation from only an issue number.

## Test Plan

- Unit: menu model builds `{ state: 'closed', stateReason: 'completed' }`, `{ state: 'closed', stateReason: 'not_planned' }`, and duplicate payloads only for valid duplicate targets.
- Unit: duplicate validation rejects missing/self/non-positive/non-integer targets.
- Existing unit: optimistic status draft reconciliation remains unchanged.
- Main unit: `updateIssue` emits `gh issue close --reason completed`, `gh issue close --reason "not planned"`, `gh issue close --duplicate-of <n>`, and `gh issue reopen`.
- Main unit: `updateIssueBySlug` uses `gh issue close/reopen --repo owner/repo` for state changes, rejects duplicate without `duplicateOf`, and does not send unsupported `duplicate_of` REST fields.
- Renderer unit: `GHStatusCell` uses slug-addressed mutation when `item.url` contains an owner/repo and falls back to `github.updateIssue` only when slug parsing is unavailable.
- Store/cache unit: successful close from an open-filtered Tasks list invalidates or refreshes the affected work-items cache so hidden-by-filter rows do not linger indefinitely.
- Electron validation: Tasks GitHub issue row status menu shows the new close options and closed issue pill is not red.
- Electron validation: duplicate close picker appears after the duplicate action and supports issue search/exact-number fallback. Do not submit a real close mutation against user data.
- Electron validation: GitHub issue detail status sidebar shows the same close options and duplicate picker as the list row.
- Electron/runtime smoke: same menu opens and validation works when the active runtime target is an SSH/environment source; avoid a real close mutation unless using disposable test data.

## UI Quality Bar

- Popover should feel like an action menu, not an error/destructive confirmation.
- Closed issue pill must be visually distinct from open but not red/destructive.
- Duplicate picker must fit in the popover at desktop and narrow widths without clipping.
- Hover, focus, disabled, and inline validation states use existing shadcn primitives/tokens.

## Review Screenshots

1. GitHub Tasks issue row with status popover open showing all close reasons.
2. Duplicate close second-step picker with search and issue candidates.
3. Closed issue row/pill showing non-red completion styling.
4. GitHub issue detail sidebar status popover showing all close reasons.
5. GitHub issue detail duplicate close second-step picker.
6. Adjacent smoke: GitHub Tasks header/search area still renders normally.

## Rollout

1. Add status menu model and tests.
2. Update `GHStatusCell` UI and mutation payload.
3. Run focused tests, typecheck, and lint.
4. Run UI quality review.
5. Validate in Electron and capture screenshots.

## Lightweight Eng Review

- Scope: kept to the GitHub Tasks status cell plus a small model module; no provider-wide or network-backed search-picker work.
- Architecture/data flow: preserves current renderer -> IPC/runtime mutation boundaries, but must route rows with parseable GitHub slugs through `updateIssueBySlug` so project/custom-source issues mutate the issue's own repository rather than the selected worktree repo.
- API feasibility: path-based mutations already use the supported `gh issue close --duplicate-of` CLI path; slug-addressed mutations need the same CLI close/reopen treatment instead of REST `duplicate_of`.
- Failure modes covered:
  - Invalid duplicate targets stay local and do not mutate.
  - Failed mutations revert optimistic state using the existing request id guard.
  - Runtime/SSH remains on the existing serializable RPC method.
  - Unsupported duplicate API shape is avoided by keeping duplicate close on `gh issue close --duplicate-of`.
  - Rows filtered by open/closed status do not rely solely on optimistic patching; the relevant work-items cache must be invalidated/refetched after success.
- Test coverage required:
  - Unit tests for close update payloads and duplicate validation.
  - Main-process tests for both `updateIssue` and `updateIssueBySlug` close/reopen command generation.
  - Renderer routing tests for slug-addressed versus repo-path-addressed issue rows.
  - Cache invalidation/refetch coverage for status-filtered Tasks lists.
  - Existing status draft tests for optimistic reconciliation.
  - Electron screenshots for menu, duplicate validation, closed styling, and adjacent header smoke.
- Performance/blast radius: no material concern; one extra tiny model import and no new polling/IPC.
- UI quality bar: compact GitHub-like action menu, token-based non-destructive closed styling, no clipping or overlap.
- Required review screenshots:
  1. Status popover with close reasons.
  2. Duplicate second-step picker with search and issue candidates.
  3. Non-red closed status pill.
  4. Tasks header/search smoke.
- Residual risks:
  - Duplicate target search is limited to loaded Tasks cache candidates, with exact-number fallback for unloaded same-repository issues.
  - Other open Orca windows may show stale status until their normal GitHub Tasks data refresh runs.
