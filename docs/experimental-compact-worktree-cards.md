# Experimental Compact Worktree Cards

## Problem

PR #2843 made compact one-line worktree cards the default in
`src/renderer/src/components/sidebar/WorktreeCard.tsx:183` and
`src/renderer/src/components/sidebar/WorktreeCard.tsx:557`. The behavior is useful for dense
sidebars, but it is visually different enough that it should be trialed behind Experimental first.
Users also cannot infer why some cards remain two-line: the hidden row only disappears when it
would carry no distinct visible metadata.

## Goal

Add an Experimental setting, off by default, that controls the compact-card behavior. When disabled,
workspace cards use the pre-compact layout: branch line stays visible, unread remains in the left
status column, PR/issue/comment/port badges stay in the metadata row, and the primary worktree uses
the pre-compact `primary` badge instead of the compact star. When enabled, keep the current compact
behavior from PR #2843.

## Non-goals

- Do not redesign worktree card metadata.
- Do not remove card property settings such as PR, ports, issue, comment, unread, or status.
- Do not change SSH, GitLab/GitHub provider lookup, prompt-cache timer, or workspace port logic.
- Do not add per-repo or per-worktree compact preferences.

## Design

1. Add `experimentalCompactWorktreeCards: boolean` to `GlobalSettings`, defaulting to `false`.
2. Add an Experimental pane toggle titled `Compact worktree cards`.
   Copy must explain the rule: cards collapse only when the second line would be redundant or empty;
   real metadata such as a different branch, repo badge, conflict/cache state, or folder badge keeps
   the card taller.
3. In `WorktreeCard`, derive `const compactCards =
   settings?.experimentalCompactWorktreeCards === true` from the existing settings read and branch
   layout:
   - Disabled: show branch row for non-folder worktrees, keep unread in the left column, keep
     PR/issue/comment/port details in the metadata row, and show the pre-compact `primary` badge.
   - Enabled: use PR #2843 compact behavior, including title-row unread, details/ports cluster, and
     primary star.
4. Preserve the accessible title tooltip in `WorktreeTitleInlineRename`; it is useful in both modes
   and replaces the native `title` attribute.
5. Keep `CacheTimer` presentational. The card can still derive cache state, but the metadata-row gate
   must only use compact gating when the experimental flag is enabled. In disabled mode, render the
   metadata row even when the cache timer is inactive.

## Data Flow

- Main process persistence loads settings via `getDefaultSettings()`.
- Renderer settings pane toggles `experimentalCompactWorktreeCards` through `updateSettings`.
- `WorktreeCard` reads `settings?.experimentalCompactWorktreeCards === true`; missing/null settings
  must behave as disabled so existing server-render tests and old profiles do not compact.
- Card layout branches locally; no IPC, SSH, or provider data path changes.

## Edge Cases

- Missing legacy setting hydrates to `false`, so existing users get the less-surprising two-line
  default after upgrade.
- Folder repos keep their folder badge in the metadata row in both modes.
- Custom display names keep branch metadata in compact mode because the branch differs.
- Repo-grouped cards with `hideRepoBadge` can become one-line only when compact mode is enabled and
  no other metadata is visible.
- Active prompt-cache timer and conflict state keep the metadata row visible in compact mode.
- SSH cards keep the SSH icon on the title row in both modes.
- Sparse checkout badges, remote-branch conflict warnings, inline agents, and lineage child chips
  are independent rows/badges and must not be hidden by the compact toggle.

## Test Plan

- Unit/render tests:
  - default settings value is `false`;
  - Experimental pane renders the toggle and explanatory copy;
  - compact disabled renders a metadata row and branch when title equals branch;
  - compact disabled keeps unread in the left status column, details/ports in the metadata row, and
    the `primary` badge for the main worktree;
  - compact enabled hides the redundant metadata row;
  - compact enabled moves unread/details/ports to the title row and uses the primary star;
  - compact enabled preserves branch row when title differs from branch;
  - title tooltip remains focusable and does not use native `title`.
- Validation:
  - Electron screenshot with compact disabled: repeated branch cards are two-line.
  - Electron screenshot with compact enabled: repeated branch cards collapse to one-line.
  - Electron screenshot of Experimental setting showing explanatory copy.

## UI Quality Bar

- Toggle follows existing Experimental pane layout, spacing, typography, and switch style.
- Copy is concise and explains what counts as metadata without teaching implementation details.
- Sidebar cards do not overlap, clip icons, or jump unexpectedly when the setting changes.
- Compact-disabled mode should look understandable rather than like an accidental regression.

## Review Screenshots

1. Experimental pane with `Compact worktree cards` toggle off.
2. Sidebar card list with compact disabled: repeated branch cards show the second line.
3. Sidebar card list with compact enabled: repeated branch cards collapse to one line.

## Rollout

1. Add setting type/default/search entry/persistence tests.
2. Add Experimental pane UI.
3. Branch `WorktreeCard` layout behind the setting.
4. Update focused render tests.
5. Validate with Electron screenshots.

## Lightweight Eng Review

- Scope: Keep the PR to one persisted Experimental flag, one settings row, and local card layout
  branching. No new metadata model or card explanation surface.
- Architecture/data flow: Settings persistence already merges defaults with parsed settings; adding
  a default-off boolean is enough for old profiles and SSH/web clients because renderer state is
  hydrated from the same settings object.
- Failure modes covered:
  - Old profiles unexpectedly compacting: default false.
  - Toggle copy failing to explain mixed one-line/two-line cards: explicit description.
  - Tests only checking branch text instead of row presence: use `data-worktree-card-meta-row`.
  - Shipping a half-compact default: assert unread placement, details/ports placement, and
    primary badge/star per mode.
  - Prompt-cache/conflict metadata disappearing: metadata-row gate keeps these rows in compact mode.
- Test coverage required:
  - `src/shared/constants.test.ts` for default value.
  - `src/renderer/src/components/settings/ExperimentalPane.test.tsx` or adjacent render test for
    settings copy/toggle behavior.
  - `src/renderer/src/components/sidebar/WorktreeCard.quick-actions.test.tsx` for enabled/disabled
    layout behavior.
  - Existing `WorktreeTitleInlineRename.test.tsx` remains relevant for tooltip behavior.
- Performance/blast radius: Reuse the existing settings read in `WorktreeCard`; no new polling, IPC,
  file watching, or provider calls.
- UI quality bar: Settings row should match existing Experimental rows; sidebar must remain dense
  but mixed-height behavior should be explainable from the toggle copy.
- Required review screenshots:
  1. Experimental setting off.
  2. Sidebar compact disabled.
  3. Sidebar compact enabled.
- Residual risks: The mixed card heights are still inherently subtle; this PR explains the rule in
  settings but does not add per-card visible reasons.
