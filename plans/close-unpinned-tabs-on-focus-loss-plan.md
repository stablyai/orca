# Plan: close unpinned editor tabs on focus loss

Status: planning only. No implementation yet.
Branch: `plan/close-unpinned-tabs-on-focus-loss` (fork: `MacielFede/orca`).

## Goal

Add a setting that closes unpinned editor file tabs when focus leaves the tab bar or the editor. Add a keybinding that toggles the pin on the active tab. Add an option to save all dirty editor tabs and close them in one step.

## Decisions so far

| Question                           | Decision                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| What counts as "focus lost"        | Focus moves from the tab bar or editor to something outside them. Not a window blur.                |
| Which tabs close                   | Editor file tabs only. Terminals, browser tabs, simulator and agent sessions are never auto-closed. |
| Unpinned tabs with unsaved changes | Stay open.                                                                                          |
| Way to clear dirty tabs            | A separate "save all and close unpinned tabs" action.                                               |
| Pin toggle shortcut                | No default binding. The action is registered and the user binds it in Settings > Shortcuts.         |

Rejected: `Mod+Alt+P`. It is bound on macOS to **Collapse / Expand All Projects** (`src/shared/keybindings/definitions-core-4.ts`). Rejected also: `Mod+Alt+K`. It has no default binding, but the keybinding conflict tests use it as the "free" sample chord for `terminal.toggleNativeChat` overrides, so it would fail them. Later decision: ship `tab.togglePin` unbound rather than pick a default chord.

## What the codebase already does

- **Window focus.** Main sends `window:active-changed` on focus and blur (`src/main/window/main-window-activity.ts`). The renderer hook is `src/renderer/src/hooks/use-window-active.ts`. This is not used by the plan, since the trigger is in-app focus, but it is the closest existing focus signal.
- **Pinning.** Each unified tab has `isPinned`. `pinTab` and `unpinTab` are in `src/renderer/src/store/slices/tabs/tabs-label-actions.ts`. `pinTab` also ends a preview tab, so pinning a preview makes it permanent. The context menus call these through `withLayoutOwnerTabProps` in `src/renderer/src/components/tab-bar/tab-bar-layout-owner-props.ts`, which sends a `setTabProps` layout command to the owner when one exists.
- **Pinned tabs are protected on close.** `handleCloseFile` in `src/renderer/src/components/use-terminal-editor-close-queue.ts` returns early for pinned tabs. `dispatchWorkspaceTabCommand` in `src/renderer/src/lib/workspace/tabs/workspace-tab-commands.ts` skips pinned tabs when `bulk` or `skipEmptyCheck` is set.
- **Existing bulk close.** `closeAllFiles` in `src/renderer/src/store/slices/editor/closing/recently-closed-editor-tabs.ts` closes every editor tab in the active worktree. It does not check pins, so it cannot be reused unchanged.
- **Dirty-file close.** `use-terminal-editor-close-queue.ts` shows a save prompt for each dirty file. It activates a file, then opens the dialog. `editorTabNeedsSavePrompt` (`src/renderer/src/store/slices/editor/tabs/editor-tab-close-target.ts`) decides whether a tab needs that prompt.
- **Saving.** Saves are driven by the `ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT` window event, handled in `src/renderer/src/components/editor/save/commands/useEditorCmdSaveRequest.ts`. That handler only saves the active file. Save-all therefore has to activate each dirty file in turn and wait for the save to finish. The save queue is in `src/renderer/src/components/editor/save/queue/`.
- **Keybindings.** Definitions are in `src/shared/keybindings/definitions-core-2.ts` (the `tab.*` group, e.g. `tab.closeAll` on `Mod+Alt+W`). Action IDs are a union in `src/shared/keybindings/types.ts`. Titles are in `src/renderer/src/components/settings/shortcuts/keybinding-title-copy.ts`. Keyboard dispatch is in `src/renderer/src/components/terminal-workspace-keydown.ts` and `src/renderer/src/app-shell/use-global-keybindings.ts`.
- **Settings.** A boolean setting touches `src/shared/global-settings-types.ts`, `src/shared/default-global-settings.ts`, a toggle in `src/renderer/src/components/settings/general/GeneralPane.tsx`, and keywords in `src/renderer/src/components/settings/general/general-search.ts`. `editorPreviewTabsEnabled` is the model. `confirmClosePinnedTab` is a close-related example.

## Proposed design

### 1. Setting

Add `closeUnpinnedEditorTabsOnFocusLoss: boolean`, default `false`. Opt-in, so existing users see no change. Add a toggle under General with search keywords (`unpinned`, `pinned`, `focus`, `close`, `tabs`).

### 2. Pin keybinding

Add `tab.togglePin` to the `tab.*` definitions with `platformBindings([])` (unbound by default), add it to the action union, and add a title entry. Dispatch it from `terminal-workspace-keydown.ts`, and from `use-global-keybindings.ts` if the chord must also work outside terminal and editor focus. Check the existing `tab.closeAll` handling in both files and copy it.

### 3. Toggle-pin command

Add a `toggle-pin` variant to `WorkspaceTabCommand` in `workspace-tab-commands.ts`. It takes the active tab of the active worktree and does the following:

- Send a `setTabProps` layout command to the owner when one exists, following `withLayoutOwnerTabProps`.
- Otherwise call `pinTab` or `unpinTab`.

Reuse the existing layout-owner helper if it can be called from outside React. Otherwise extract the shared logic into a module both call. Do not duplicate it.

### 4. Close unpinned editor tabs

Add `closeUnpinnedEditorTabs(worktreeId)` with this rule:

- Consider only editor content types (`isEditorTabContentType`).
- Skip pinned tabs.
- Skip tabs where `editorTabNeedsSavePrompt` is true.
- Close the rest by dispatching `{ type: 'close', bulk: true, target: { kind: 'tab', worktreeId, tabId } }`. Bulk already skips pinned tabs, which keeps the rule in one place.

Preview tabs are unpinned by default, so they will close too. Confirm this is wanted.

### 5. Focus-loss trigger

Add a hook mounted in the app shell that listens for `focusout` at the document level.

- Ignore the event unless `event.target` is inside the tab bar or the editor panel.
- Ignore it if `relatedTarget` is inside the tab bar, the editor, or an open overlay. Radix menus and dialogs render in portals and take focus when they open, so overlays must be recognized by the element that receives focus, not by the tab bar's DOM.
- Otherwise call `closeUnpinnedEditorTabs` for the active worktree, when the setting is on.

The tab bar and editor containers need stable selectors (data attributes). I have not identified them yet. Check `src/renderer/src/components/tab-bar/TabBar*.tsx` and `src/renderer/src/components/editor/EditorPanel.tsx`.

### 6. Save all and close unpinned

Add an action that does the following for each unpinned, dirty editor tab in the active worktree:

1. Activate the tab.
2. Dispatch `ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT` for its file.
3. Wait until the save reports success, using the existing save-result path (`editor-saved-event-view.ts` or the save queue's completion).
4. Close the tab with the `closeUnpinnedEditorTabs` rule.

If a save fails (stale disk, not UTF-8, permission error), leave that tab open and continue with the rest. Report the failures at the end.

Place the action in the editor file tab context menu (`EditorFileTabContextMenu.tsx`) as "Save and Close Unpinned Tabs". Confirm this placement tomorrow.

## Resolved decisions

Answers from review. These replace the earlier open questions.

1. **Terminal focus.** Focus moving into a terminal (or any non-editor surface) closes unpinned editor tabs. Literal reading of the goal.
2. **Empty chrome.** A focus move to `body` (`relatedTarget: null`) closes tabs, with one refinement: if the pointer went down inside the tab bar or editor, the null focus move is still inside the same surface and does not close. This stops clicks in Monaco's gutter or the empty part of the editor from closing tabs.
3. **Window switch.** Ignored. Window blur does not close tabs (`document.hasFocus()` is false during blur). This matches the decisions table.
4. **Save-all placement.** Editor tab context menu ("Save and Close Unpinned Tabs") and the Cmd+J quick actions list. Orca has no generic command palette; Cmd+J is its palette.
5. **Preview tabs.** Close like any other unpinned editor tab.
6. **Save path.** Save-all uses a store-level handle to the save queue, not the mounted editor. `attachEditorAutosaveController` registers its `queueSave` path, and save-all calls it per dirty tab, awaiting each `EditorSaveResult`. This works without the editor mounted and covers remote and folder files because it goes through the same queue as Ctrl+S.
7. **Close path.** Unpinned editor tabs close through `dispatchWorkspaceTabCommand({ type: 'close', bulk: true })`. `closeItem` already waits for custom-editor frame flushes and routes any dirty prompt through the central guard.
8. **Pin path.** The toggle reuses `withLayoutOwnerTabProps` when the layout owner is main, and falls back to `pinFile`/`pinTab`/`unpinTab` locally. Editor pins go through `pinFile` so preview tabs are made permanent.
9. **Focus zones.** Stable selectors are `data-tab-focus-zone="tab-bar"` on `TabBarSurface` and `data-tab-focus-zone="editor"` on `EditorPanelShell`.
10. **Overlays.** `relatedTarget` inside `[role=menu|listbox|dialog|alertdialog]` or a Radix popper wrapper is ignored.
11. **Detached targets.** A `focusout` whose target has been removed from the DOM is ignored, so closing a tab does not cascade into closing the rest.
12. **Save-all shortcut.** `tab.saveAndCloseUnpinned` is registered with no default binding, like `tab.togglePin`. The user binds it in Settings > Shortcuts. The context menu item shows the bound chord.

## Risks

- **Data loss.** Only clean tabs may close automatically. Dirty tabs must pass through `editorTabNeedsSavePrompt` or the save flow.
- **Focus churn.** Radix overlays, the command palette and the file finder all move focus. Without the overlay check, opening any of them would close tabs.
- **Race with saves.** Save-all activates tabs one at a time. The save queue must finish before the next tab is activated, or a save can land on the wrong file.
- **Layout owner ownership.** Writing pin state locally when the main process owns layout would desync the two.

## Checks

From `AGENTS.md`:

- Do not add tests by default. Add one only if it fails when the change is reverted, hardcodes its expected values, and tests the one layer that owns the behavior.
- `pnpm tc` for typecheck.
- `pnpm exec oxlint <files>` and `pnpm exec oxfmt --check <files>`.
- `pnpm check:changed` before pushing. Never use `--no-verify`.
- For UI checks, run the app with `ORCA_BACKGROUND_LAUNCH=1`. Do not steal focus. Use CDP screenshots of hidden renderers.
- Follow `docs/STYLEGUIDE.md` for any UI change.

## Steps for tomorrow

- [x] Resolve open questions with the user (see Resolved decisions).
- [x] Identify DOM selectors for the tab bar and editor panel (`data-tab-focus-zone`).
- [x] Read `closeUnifiedTab` and `editorTabNeedsSavePrompt` to confirm active-tab behavior.
- [x] Read the layout-owner helper (`sendLayoutCommandToOwner`); it reads the store directly, so it works outside React.
- [x] Read the save-result path; the controller's `queueSave` returns `EditorSaveResult`.
- [ ] Implement in this order: keybinding and command, setting, close action, focus trigger, save-all.
- [ ] Run `pnpm tc`, lint and format on changed files, then `pnpm check:changed`.
- [ ] Verify manually in the app, including remote and folder workspaces.
- [ ] Push to `fork` once everything above is done (not before).
