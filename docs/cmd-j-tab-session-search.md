# Cmd-J Tab and Agent Session Search

## Problem

Cmd-J can already search worktrees, settings, actions, browser pages, and simulator tabs, but not ordinary open terminal/editor tabs or their agent-session context. The existing open-tab list only combines browser and simulator matches in `WorktreeJumpPalette.tsx` (`browserItems`, `simulatorItems`, `openTabItems`). Terminal/editor activation exists elsewhere, notably the shortcut activation path in `src/renderer/src/lib/tab-number-shortcuts.ts`, but Cmd-J has no searchable row for those tab kinds. Agent prompt/session metadata is structured and bounded in `AgentStatusEntry`, `RetainedAgentEntry`, and `SleepingAgentSessionRecord`, yet Cmd-J does not index it.

## Goal

Let users open the existing Worktree Palette shortcut (`Cmd+J` on macOS, `Ctrl+Shift+J` on Windows/Linux by default) and type keywords from:

1. Open terminal and editor tab titles.
2. Live or retained agent prompts/session ids associated with terminal panes.
3. Sleeping agent session prompt/title/session-id metadata only when it can be attributed to an existing terminal tab.
4. Worktree and repo metadata, matching the current browser/simulator tab behavior.

Selecting a matched tab should activate the owning worktree, split group, and tab, then focus the right surface for terminal/editor tabs.

## Non-goals

- Do not index terminal scrollback, file contents, or full assistant messages.
- Do not add a new global search backend, IPC channel, persistence field, or database.
- Do not change Cmd-J shortcut registration or platform key labels.
- Do not alter worktree/settings/action ranking semantics outside combining the new tab result list.
- Do not support launching/resuming a sleeping agent session from the result row; this feature only navigates to existing open tabs.

## Design

1. Add a focused tab-search helper, likely `src/renderer/src/lib/workspace-tab-palette-search.ts`, modeled after `simulator-palette-search.ts`. It should build searchable entries from `unifiedTabsByWorktree` for terminal tabs and editor-family tabs (`editor`, `diff`, `conflict-review`, `check-details`; markdown preview is an `editor` tab whose `OpenFile.mode` is `markdown-preview`). Do not fold browser/simulator into this helper unless tests prove their current scoring, empty-query comparators, rendering data, and activation behavior are unchanged.

2. Resolve displayed titles through existing sources:
   - Terminal: map the unified terminal tab's `entityId` to `tabsByWorktree[worktreeId]`, then use `resolveTerminalTabTitle` from `src/shared/tab-title-resolution.ts:3` with `settings.tabAutoGenerateTitle`.
   - Editor-family tabs: map the unified tab's `entityId` to `openFiles`, then use `getEditorDisplayLabel`, with relative path/full path as secondary searchable text. If the backing `OpenFile` is missing, do not create a searchable editor row; `setActiveFile` cannot safely restore it.
   - Terminal fallback: use `resolveUnifiedTabLabel` from `src/shared/tab-title-resolution.ts:17` only when a terminal's legacy `TerminalTab` record is missing but the unified terminal tab still exists.

3. Add agent-session keywords only from bounded structured state:
   - `agentStatusByPaneKey`: `prompt`, `agentType`, `state`, `providerSession.key/id`, `terminalTitle`, and capped `stateHistory[].prompt`.
   - `retainedAgentsByPaneKey`: the retained `entry` fields above plus the retained terminal tab title snapshot.
   - `sleepingAgentSessionsByPaneKey`: `prompt`, `agent`, `providerSession.key/id`, `state`, and `terminalTitle`.
   Attach metadata to a terminal row only when it matches that terminal by explicit `tabId`, by retained `tab.id`, or by pane-key prefix `${terminalTabId}:`, where `terminalTabId` is the legacy terminal id (`unifiedTab.entityId`). The worktree must also match when the record carries one. Do not include terminal scrollback, full assistant messages, `lastAssistantMessage`, `toolName`, or `toolInput`. Keep rendered snippets trimmed/capped even though hook payloads and history length are already bounded.

4. Rank with predictable field weights:
   - Displayed tab title: highest priority. Terminal title precedence must match `resolveTerminalTabTitle`: custom title, quick-command label, generated title only when enabled, raw title, then fallback. Editor title precedence must match `getEditorDisplayLabel`.
   - Agent prompt/session metadata: next, shown as supporting text when it caused the match.
   - Worktree name and repo name: lower priority, matching browser/simulator ordering.
   - Empty query: preserve current behavior by showing open tab rows. Existing browser/simulator helpers compute context-first scores, but `WorktreeJumpPalette` currently merges all open-tab item types by `result.score` and then item id; do not replace that final merge comparator unless tests deliberately cover the browser/simulator ordering change. New terminal/editor rows should encode deterministic context-first ordering in their scores: current tab, current worktree, worktree order, then group/tab order. Browser/simulator already index across all worktrees, including archived/default-hidden worktrees; terminal/editor rows may follow that open-tab behavior, but only for rows backed by existing unified tabs.

5. Integrate in `WorktreeJumpPalette.tsx` with a small new `WorkspaceTabPaletteItem` type and helper import. Add explicit store selectors for the new inputs (`openFiles`, `retainedAgentsByPaneKey`, `sleepingAgentSessionsByPaneKey`, `activeTabId`, `activeTabIdByWorktree`, `activeFileId`, `activeFileIdByWorktree`, and `activeTabTypeByWorktree` for current-row detection). Replace `openTabItems` with browser + simulator + workspace tab items sorted by the existing combined open-tab ordering, keeping the existing `OPEN TABS` section and caps.

6. Add a generic tab activation helper, likely `src/renderer/src/lib/workspace-tab-palette-activation.ts`, that mirrors `activateTabNumberShortcut` (`src/renderer/src/lib/tab-number-shortcuts.ts:57`) and existing simulator selection (`src/renderer/src/components/WorktreeJumpPalette.tsx:1090`). Re-resolve the target from `useAppStore.getState()` at selection time before mutating state:
   - `activateAndRevealWorktree(worktreeId)`.
   - Verify the target worktree, group, and unified tab still exist; the tab must still have the expected content type and still belong to the target worktree/group. Return with the same toast pattern before mutating state if any of those checks fail.
   - Terminal: activate web runtime session when needed using `getRuntimeEnvironmentIdForWorktree`, `isWebRuntimeSessionActive`, and `activateWebRuntimeSessionTab`; set `activeTab` to terminal `entityId`; set active type to `terminal`; then `focusTerminalTabSurface(entityId)`.
   - Editor-family tabs: verify `openFiles` still contains `entityId`; focus the target group, set active file to `entityId`, activate the unified tab id, then set active type to `editor`. Activating after `setActiveFile` preserves the specific split tab and is required for `check-details`, which `setActiveFile` does not implicitly re-find.
   - Simulator/browser behavior should remain unchanged unless the shared helper explicitly preserves existing semantics.

7. Render terminal/editor rows with the existing open-tab row density and tokens near `src/renderer/src/components/WorktreeJumpPalette.tsx:1697`: icon, highlighted title, current-tab/current-worktree chip, supporting text, worktree, host badge, and repo badge. Use existing icons (`SquareTerminal`, `FileText` or file-type icon if cheap and already available). Update the no-results subtitle at `src/renderer/src/components/WorktreeJumpPalette.tsx:1385` to include tab title/agent prompt without making it verbose.

8. Keep generated lists computed in `useMemo`; all required source data already exists in the renderer store, but `WorktreeJumpPalette` must subscribe to the slices it does not currently read. No new IPC, polling, filesystem reads, persistence fields, or shared mutable cache are needed. Search work should stay proportional to open unified tabs plus the small in-memory agent maps.

## Data flow

- Store slices expose `unifiedTabsByWorktree`, `tabsByWorktree`, `openFiles`, worktrees/repos, live agent statuses, retained agents, sleeping sessions, active group ids, and active terminal/editor ids.
- `buildSearchableWorkspaceTabs(...)` produces one entry per open terminal/editor tab with resolved labels and bounded agent keywords.
- `searchWorkspaceTabs(entries, query)` returns scored/highlighted results.
- `WorktreeJumpPalette` maps results to open-tab rows.
- User selects a row.
- Selection re-resolves the target from the live store, activates the owning worktree/group/tab, and focuses terminal/editor as appropriate.

## Edge cases

- Custom title, quick-command label, generated title, and raw title should follow the same precedence as the tab bar.
- Generated titles disabled: do not make generated terminal/unified labels the displayed title or a title-weighted match. It is acceptable to search bounded agent prompt/session metadata regardless of this setting.
- Split groups: activate the result's `groupId`, not just the worktree's last active group.
- Terminal unified tab missing its legacy terminal record: still show a fallback title from the unified tab and navigate if the unified tab exists.
- Editor-family unified tab missing its `OpenFile`: omit the row and treat selection as stale if it disappears after search.
- Markdown preview tabs: include them through `contentType: 'editor'` and `getEditorDisplayLabel`; do not look for a separate unified content type.
- Current-row detection is type-specific: terminal active ids are legacy terminal ids, editor active ids are file ids, while unified group state stores unified tab ids.
- Agent pane keys are composite `${tabId}:${leafId}`; only attach agent metadata when it is attributed to the result tab by explicit `tabId`, retained `tab.id`, or pane-key prefix and does not conflict with record `worktreeId`.
- Multiple agent panes in one terminal tab: include all bounded agent prompts/metadata, but show only the best matching supporting snippet.
- Sleeping sessions: search metadata only when tied to an existing terminal tab; selecting the row must navigate to that tab and must not call resume/launch logic, regardless of `origin`.
- Archived/default-hidden worktrees: preserve current open-tab search behavior by indexing open tabs across all worktrees.
- SSH/web runtime tabs: activation must call the existing runtime activation path where terminal/browser tab shortcuts already do.
- One-character query: keep the existing two-character minimum only for settings/actions; open-tab search follows current browser/simulator tab search behavior and may match one character.
- Stale records: ignore agent records whose tab id cannot be tied to an existing open tab; do not create standalone agent-session rows.
- Duplicate metadata from live + retained + sleeping records: de-duplicate by pane key and prefer live, then retained, then sleeping for keywords/supporting snippets.
- External mutations during selection: if the target tab, backing `OpenFile`, group, or worktree disappeared after search, close nothing and show the same toast-and-return pattern used for missing browser/simulator rows. Validate all of these before calling `focusGroup`, because `focusGroup` itself will stamp the requested group id even if the group was removed.

## Test plan

- Unit: add `workspace-tab-palette-search.test.ts` covering terminal title precedence, generated-title disabled behavior, editor label/path search for every editor-family content type and markdown preview mode, agent prompt/session search, retained/sleeping metadata attribution by legacy terminal id, stale/orphan metadata exclusion, split-group current-tab detection, and deterministic ordering.
- Unit: update/add `WorktreeJumpPalette` tests only if there is an existing lightweight component harness; otherwise cover integration behavior through pure helper tests and targeted activation helper tests.
- Unit: add activation tests for a helper if extracted from `WorktreeJumpPalette`, including terminal web-runtime activation, editor-family activation for `editor`/`diff`/`conflict-review`/`check-details`, missing tab/group/backing-file/worktree failures, and split group focus.
- Regression: ensure existing `simulator-palette-search.test.ts` and `palette-results.test.ts` still pass.
- Validation: Electron golden path for searching a terminal tab title/agent prompt and selecting it, plus an editor-family tab selection; adjacent smoke for existing browser/simulator open-tab rows.

## UI Quality Bar

User-visible. The new rows must look like the existing Open Tabs rows: same spacing, typography, selection state, highlight weight, badges, truncation, host/repo badges, and row density. Long tab titles, prompts, repo names, and worktree names must truncate without overlap or layout jitter in the 736px palette and under the existing `max-w-[94vw]` mobile/narrow constraint. Use documented tokens and existing shadcn/cmdk row primitives; no new color values, font sizes, shadows, or card styling.

## Review Screenshots

1. Empty Cmd-J palette with Open Tabs showing a terminal/editor tab alongside existing tab rows.
2. Typed query matching a terminal tab title.
3. Typed query matching an agent prompt/session keyword with supporting text visible.
4. Typed query matching an editor tab title or path.
5. Adjacent smoke: existing browser or simulator tab search result still appears and keeps its styling.

## Rollout

1. Add the pure tab-search helper and unit tests.
2. Add/extract a small tab-activation helper if needed and unit-test it.
3. Wire `WorktreeJumpPalette` to build/search/render/select workspace tab rows.
4. Update no-results copy and imports.
5. Run targeted tests, typecheck, lint.
6. Validate in Electron and capture required screenshots.

## Lightweight Eng Review

- Scope: reduced to open terminal/editor tab navigation plus bounded agent prompt/session-id/title metadata. No terminal scrollback, file-content search, standalone sleeping-session rows, or resume/launch actions.
- Architecture/data flow: renderer-only helper fed by explicit `WorktreeJumpPalette` store snapshots; selection re-resolves live state and delegates to a small activation helper that preserves current worktree/group/tab and web-runtime activation boundaries.
- Failure modes covered:
  - stale tab/group/backing file/worktree between search and select -> toast and no state mutation beyond current palette behavior
  - duplicated live/retained/sleeping metadata -> de-dupe by pane key with live records preferred
  - orphan or cross-worktree agent records -> ignored unless tied to an existing terminal tab
  - split groups -> activate result `groupId`
  - generated titles disabled or overridden -> displayed title follows tab-bar precedence while agent prompt remains searchable
  - SSH/web runtime -> reuse existing runtime activation call shape
  - multi-window renderer state -> no shared cache or persisted search index
- Test coverage required:
  - `src/renderer/src/lib/workspace-tab-palette-search.test.ts`: title precedence, editor path/title across editor-family types including markdown preview, agent prompt/session id, retained/sleeping attribution by legacy terminal id, duplicate metadata, orphan exclusion, current-tab/current-worktree ordering
  - `src/renderer/src/lib/workspace-tab-palette-activation.test.ts`: terminal/editor-family activation, split group focus, web-runtime terminal activation, missing tab/group/backing-file/worktree failures
  - existing `src/renderer/src/lib/simulator-palette-search.test.ts` and `src/renderer/src/components/cmd-j/palette-results.test.ts` unchanged/pass
- Performance/blast radius: no new IPC, persistence, polling, filesystem search, or terminal output indexing. Work is proportional to current open tabs and small bounded agent maps already in memory.
- UI quality bar: Electron validation must compare new rows with existing Open Tabs rows against `docs/STYLEGUIDE.md`, with no new colors/shadows/font sizes and no overflow/overlap under narrow palette width.
- Required review screenshots:
  1. Empty Cmd-J palette with terminal/editor rows in Open Tabs.
  2. Typed query matching a terminal title.
  3. Typed query matching an agent prompt/session keyword.
  4. Typed query matching an editor tab title/path.
  5. Existing browser or simulator tab search still styled correctly.
- Residual risks: Electron validation may need to seed a live agent prompt; if a real prompt cannot be created safely, use an existing local non-mutating agent tab or halt before PR creation with nearest screenshots.
