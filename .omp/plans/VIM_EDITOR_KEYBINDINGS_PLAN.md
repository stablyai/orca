# Vim keybindings for the file editor

## Context

GitHub #26921 asks for Vim mode in Orca's built-in editor so modal-editing users can make quick manual edits without leaving Orca. Orca embeds Monaco (`monaco-editor` `^0.55.1` via `@monaco-editor/react`), not a VS Code extension host, so the VSCodeVim extension cannot be installed.

End state: Settings → General → Editor has an **Editor Keybindings** control, **Default** (the persisted default) or **Vim**. Vim is off until chosen. Writable full-height Monaco file editors, Markdown source mode, writable conflict surfaces that already use `MonacoEditor`, and the modified side of an editable single-file diff then start in Normal mode, show the adapter's mode/pending/Ex text in a status row, and route `:w` through the surface's existing save callback. Default users see no status row and no key-handling change.

Delivery is the Vim-first contract, not a VS Code extension host and not the extra commands in unmerged dirty PR #9755. Do not cherry-pick that PR. `MonacoEditor` has since been split into `useMonacoEditorMount` / `installMonacoEditorInputBindings`; implement against those seams.

## Approach

### 1. Persist an extensible preset, default off

Add optional `editorKeybindings?: 'default' | 'vim'` on `GlobalSettings` in `src/shared/global-settings-types.ts` immediately after `editorWordWrap`. Set `editorKeybindings: 'default'` in `buildDefaultSettings` in `src/shared/default-global-settings.ts` next to `editorWordWrap: true`.

Add `resolveEditorKeybindings(value: string | undefined): 'default' | 'vim'` in a new `src/shared/editor-keybindings.ts`. Return `'vim'` only when `value === 'vim'`. Every other value, including `undefined`, `''`, and any future unknown string, returns `'default'`. Do not write the coerced value back. `sanitizeRendererSettingsUpdate` in `src/main/ipc/settings.ts` already passes ordinary `Partial<GlobalSettings>` fields through; do not add a special case.

No main-process, filesystem, Git, SSH, relay, or workspace protocol change. Folder workspaces and SSH workspaces keep using the same renderer editor and the same `onSave` path.

### 2. Settings row, searchable

Add `src/renderer/src/components/settings/EditorKeybindingsSetting.tsx`, copied from `EditorWordWrapSetting.tsx` (same `SearchableSetting` + `Label` + description + `SettingsSegmentedControl` layout, `className="flex items-center justify-between gap-4 py-2"`). Do not invent a new control.

- Title `Editor Keybindings`, description `Use Vim motions in writable file editors. Default keeps the current editor keys.`
- `translate()` keys: `auto.components.settings.EditorKeybindingsSetting.title`, `.description`, `.default`, `.vim`. English fallbacks are the strings above plus `Default` and `Vim`. `translate()` already supplies `defaultValue`, so do not hand-edit `ja`/`zh`/`es`/`ko`.
- `keywords={['editor', 'keybindings', 'keymap', 'vim', 'modal', 'normal mode']}`
- `ariaLabel` is the title. Options are `{ value: 'default', label: Default }` and `{ value: 'vim', label: Vim }`.
- `value={resolveEditorKeybindings(settings.editorKeybindings)}`. `onChange` calls `updateSettings({ editorKeybindings: option })` with the segmented value, including an explicit `'default'` (do not delete the key).

Render `<EditorKeybindingsSetting settings={settings} updateSettings={updateSettings} />` in `GeneralEditorSettingsSection.tsx` immediately after `<EditorWordWrapSetting ... />`.

Add a catalog entry to `getGeneralEditorSearchEntries()` in `src/renderer/src/components/settings/general-editor-search.ts`, same shape as the Editor Word Wrap entry. Title/description keys: `auto.components.settings.general.search.editorKeybindings` and `...editorKeybindingsDesc` with the same English strings. Keywords via `translateSearchKeyword`: `vim`, `keybindings`, `modal`, `editor`. Both layers are required: `SearchableSetting` only filters a row inside a section `GeneralPane` already decided to show from this catalog.

### 3. Dependency and one attachment seam

Add runtime dependency `monaco-vim@0.4.4` (MIT, peer `monaco-editor: *`) with `pnpm add monaco-vim@0.4.4` from this worktree. If `node_modules` is missing, `pnpm install` first. Do not load it from a CDN or `loader.js`. The published `dist/index.mjs` imports `monaco-editor/esm/vs/editor/editor.api` and `monaco-editor/esm/vs/editor/common/commands/shiftCommand`. That `shiftCommand.js` file exists in the installed `monaco-editor@0.55.1`. Do not vendor the package.

New `src/renderer/src/components/editor/monaco-vim-mode.ts`. No equivalent exists. It is the only module that imports `monaco-vim`, and only via `await import('monaco-vim')`. Nothing else static-imports it.

```ts
export type VimAttachment = { dispose: () => void }

export function shouldAttachEditorVim(args: {
  preset: 'default' | 'vim'
  readOnly: boolean
  autoHeight: boolean
}): boolean

export function attachMonacoVimMode(args: {
  editor: editor.IStandaloneCodeEditor
  statusNode: HTMLElement
  onWriteRef: { readonly current: () => void }
  signal: AbortSignal
}): Promise<VimAttachment>
```

`shouldAttachEditorVim` is `preset === 'vim' && !readOnly && !autoHeight`.

`attachMonacoVimMode`:

- Dynamic-import `monaco-vim`. If `signal.aborted` before or after the import, return a no-op `{ dispose() {} }` and do not call `initVimMode`. If aborted after `initVimMode`, call `vim.dispose()` and return a no-op.
- Call `initVimMode(editor, statusNode)`. The library owns the status text (`--NORMAL--`, `--INSERT--`, `--VISUAL--`, `--VISUAL LINE--`, `--VISUAL BLOCK--`, key buffer, Ex input). Do not replace that text and do not pass a custom `StatusBar` class.
- Register Ex `write` / `w` once per page, not once per editor. `monaco-vim` exposes CodeMirror's `VimMode.Vim.defineEx`. If the published type omits `.Vim`, one line-specific `SAFETY:` cast is allowed: the runtime export has `.Vim`. Guard with a module-level `exRegistered` flag so a second editor does not stack handlers. If `defineEx` throws, leave the flag false so a later attach can retry, dispose this adapter, and rethrow.
- The `:w` callback ignores its arguments and calls `focusedWrite?.onWriteRef.current()`. It must not read or write files, touch IPC, or call `editor.getModel()` itself. The caller owns save.
- Module-level `focusedWrite: { editor, onWriteRef } | null`. Claim it at attach only when `editor.hasTextFocus()`. Always claim it from `editor.onDidFocusEditorText`. On dispose, if `focusedWrite.editor === editor`, set it to `null`. A newly mounted unfocused editor must not steal `:w` from a focused sibling. This is required because `defineEx` is process-global; do not keep a "last mounted editor" closure.
- Before `initVimMode`, add a capture-phase `keydown` listener on `editor.getContainerDomNode()`:
  - If `event.key !== 'Escape'`, return.
  - If `.find-widget` inside that container is missing or `aria-hidden="true"`, return (vim must receive Escape).
  - Otherwise `preventDefault`, `stopPropagation`, and `editor.trigger('keyboard', 'closeFindWidget', null)`. `closeFindWidget` is the command id in Monaco 0.55 (`FIND_IDS.CloseFindWidgetCommand`). `preventDefault` alone is not enough: monaco-vim's handler is `defaultPrevented & keyCode !== Escape`, so Escape is still consumed unless propagation stops.
- Dispose is idempotent: remove the Escape listener, dispose the focus subscription, clear `focusedWrite` if it is this editor, `vim.dispose()`.
- On any throw (import, `initVimMode`, `defineEx`): dispose whatever was attached, `console.error('Vim keybindings failed to attach', error instanceof Error ? error.message : 'unknown')`, and rethrow so the caller leaves Default keybindings in place. Do not toast. Do not log file content, file path, or the buffer.

New `src/renderer/src/components/editor/use-monaco-vim-attachment.ts`:

```ts
export function useMonacoVimAttachment(args: {
  editor: editor.IStandaloneCodeEditor | null
  enabled: boolean
  onWrite: () => void
  statusNode: HTMLElement | null
}): void
```

Store `onWrite` in a ref updated during render. Effect deps are `editor`, `enabled`, `statusNode` only, so a new `onWrite` identity does not reattach. When `enabled` is false or either node is null, do nothing. Otherwise `AbortController` + `attachMonacoVimMode`. Cleanup aborts and calls `dispose()`. After a successful attach, `requestAnimationFrame(() => editor.layout())` once so the new status row does not cover the last line (`automaticLayout` watches the editor container, which just shrank). If the effect cleaned up before that frame, cancel it.

If the status node's text is not `--NORMAL--` after `initVimMode` returns, dispatch one `KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })` on the editor container, then stop. Do not repeat this on later keystrokes. Transient mode is not persisted across remount.

### 4. Attach it to writable full-height file editors

In `MonacoEditor.tsx`, read `settings?.editorKeybindings` and `const vimEnabled = shouldAttachEditorVim({ preset: resolveEditorKeybindings(...), readOnly, autoHeight })`.

Keep `key={modelUri}` on `<Editor>`. Do not add the preset to that key, do not change `defaultValue` / `keepCurrentModel` / `saveViewState={false}`, and do not call `setValue` when the preset flips. Toggling must keep content, cursor, scroll, dirty state, and Monaco's undo stack.

For `autoHeight`, leave the current single `relative` wrapper alone (vim never attaches; conflict-review previews pass `autoHeight: true`). For every other mount, always render this structure, even when Vim is off, so showing the status row does not change the `<Editor>` parent and remount Monaco:

```tsx
<div className="flex h-full min-h-0 flex-col">
  <div ref={editorContainerRef} className="relative min-h-0 flex-1">
    {/* existing overlay, Editor, toast, gutter menu */}
  </div>
  {vimEnabled ? (
    <div
      ref={vimStatusRef}
      data-vim-status
      aria-live="polite"
      className="min-h-6 shrink-0 border-t border-border bg-editor-surface px-2 text-xs text-muted-foreground"
    />
  ) : null}
</div>
```

`editorContainerRef` moves onto the editor body, not the status row. Comment-popover measurement uses that ref and must keep measuring the editor box. Do not set `overflow-hidden` (the library puts the Ex `<input>` in the status node). Do not set `pointer-events-none`. The library sets `style.display` and `float: right` on its own spans; do not restyle those spans. Tokens only: `border-border`, `bg-editor-surface`, `text-muted-foreground`, `text-xs`. No new color, font size, or shadow.

Call `useMonacoVimAttachment` with `editor={mountedEditor}`, `enabled={vimEnabled}`, `statusNode` from the ref (state updated when the node mounts, so the effect sees a non-null node), and `onWrite={() => propsRef.current.onSave(editor.getValue())}`. `propsRef` already holds the latest `onSave`. Save shortcut installation stays in `installMonacoEditorInputBindings` during `onMount`, which runs before this effect. Do not reinstall Save/Find.

`readOnly` or `autoHeight` becoming true disposes the attachment via `enabled`. Markdown rich/preview, notebooks, and live-tail views do not use this writable full-height path; do not touch them.

### 5. Editable single-file diffs: modified side only

`DiffViewer.tsx` already has `flex flex-col flex-1 min-h-0` and installs Save/Find on the modified editor inside `handleMount` before `setModifiedEditor`. Do not attach inside `handleMount` (that callback's identity changes). After mount:

- `vimEnabled = editable && shouldAttachEditorVim({ preset: resolveEditorKeybindings(settings?.editorKeybindings), readOnly: false, autoHeight: false })`. `editable` is already `diffSource === 'unstaged'` for `EditorDiffFileSurface`, and always true for `ChangesModeView`. Read-only branch/review diffs stay `editable={false}`.
- Render the same `data-vim-status` classes as a sibling after the `flex-1 min-h-0 relative` editor wrapper and before `{toastNode}`, only when `vimEnabled`. Do not wrap `<DiffEditor>` in a new conditional parent.
- `useMonacoVimAttachment({ editor: modifiedEditor, enabled: vimEnabled, statusNode, onWrite: () => onSaveRef.current?.(modifiedEditor.getValue()) })`. `onSaveRef` already tracks the latest save callback. If `onSaveRef.current` is missing, the `:w` callback no-ops.
- Never call `attachMonacoVimMode` on `getOriginalEditor()`. `originalEditable` stays false.

Do not attach in `DiffSectionBody`, `DiffSectionItem`, or `CombinedDiffViewer`. Combined-diff sections are out of this delivery even when a section is an unstaged edit.

### 6. What Vim does, and what it must not

Behavior comes from `monaco-vim` (CodeMirror Vim bridged to Monaco), not a new engine. Required, and covered by the Electron check below: start in Normal mode; a Normal-mode letter does not insert; `i` enters Insert; Escape returns to Normal; a motion/operator edits the model; undo still works; `:w` saves through Orca.

Do not register `:q`, `:q!`, `:wq`, `:x`, `:set`, or any other Ex command. Do not add a cheatsheet. Do not read `.vimrc`, load plugins, or embed Neovim. An unknown Ex command stays the library's own status notification. `:q` must not close a tab.

Orca Save (`editor.save`), Find (`editor.find`), review-note, and diff-navigation chords stay on their existing capture-phase listeners (`editor-shortcuts.ts` `preventDefault` + `stopPropagation`, platform via `getShortcutPlatform()` and the user's keybindings). Do not hardcode `metaKey`. Do not add a Vim entry to the app keybinding catalog.

### 7. If the adapter does not bind to this Monaco

Do not write a home-grown Vim mode and do not vendor `monaco-vim`.

- If `await import('monaco-vim')` fails to resolve `monaco-editor/esm/vs/editor/common/commands/shiftCommand`, or the Electron check shows Normal-mode letters still inserting (two Monaco copies), add `dedupe: ['monaco-editor']` to `renderer.resolve` in `electron.vite.config.ts` (the existing `alias` block at the renderer `resolve` key). Re-run the Electron check.
- If dedupe is not enough because the internal import still hits a second copy, add one alias next to the existing renderer aliases, pointing `monaco-editor/esm/vs/editor/common/commands/shiftCommand` at `node_modules/monaco-editor/esm/vs/editor/common/commands/shiftCommand.js` under this worktree. Do not alias the public `monaco-editor` entry away from the instance `src/renderer/src/lib/monaco-setup.ts` passes to `loader.config({ monaco })`.
- `>>` / `<<` call `new ShiftCommand(selection, opts)` without the third `ILanguageConfigurationService` argument, and read `editor._getViewModel().cursorConfig`. If those operators throw, leave them. monaco-vim already `console.error`s a failed command and must not blank the editor. Do not fork the package to fix indent.
- If `initVimMode` still throws after the dedupe/alias attempt, the catch in step 3 is the product behavior: the setting remains selectable, the editor stays on Default keybindings, and the Electron check cannot be called passing. Stop there. Do not ship a partial keymap.

## Critical files & anchors

- `src/renderer/src/components/editor/MonacoEditor.tsx` — file-editor mount; `key={modelUri}` must stay; wrapper change is here so toggle does not remount.
- `src/renderer/src/components/editor/use-monaco-editor-mount.ts` — `installMonacoEditorInputBindings` already runs at `onMount` before any vim effect. Do not move those shortcuts.
- `src/renderer/src/components/editor/DiffViewer.tsx` — `handleMount` around the modified-editor Save shortcut; status row is a sibling of the `flex-1` editor wrapper.
- `src/renderer/src/components/settings/EditorWordWrapSetting.tsx` — settings-row pattern to copy, including the `createRoot` test.
- `electron.vite.config.ts` renderer `resolve` — only touch this if step 7's first smoke fails.

## Verification

From this worktree, after `pnpm install` if `node_modules` is missing.

Unit:

- `pnpm test src/shared/constants.test.ts src/renderer/src/components/settings/EditorKeybindingsSetting.test.tsx src/renderer/src/components/settings/GeneralPane.test.ts`
- `constants.test.ts`: `getDefaultSettings('/tmp').editorKeybindings` is `'default'`.
- New `EditorKeybindingsSetting.test.tsx`, same `createRoot` + `act` harness as `EditorWordWrapSetting.test.tsx`: omitted `editorKeybindings` shows the Default radio `aria-checked`; clicking Vim calls `updateSettings({ editorKeybindings: 'vim' })`; clicking Default calls `updateSettings({ editorKeybindings: 'default' })`.
- `GeneralPane.test.ts`: `matchesSettingsSearch('vim', getGeneralPaneSearchEntries())` and `matchesSettingsSearch('keybindings', ...)` are true.
- A node test for `resolveEditorKeybindings`: `undefined`, `'default'`, `''`, and `'emacs'` return `'default'`; `'vim'` returns `'vim'`.

Electron, the behavior proof. `ORCA_BACKGROUND_LAUNCH=1 pnpm test:e2e -- tests/e2e/vim-keybindings-file-editor.spec.ts`. Harness is `import { test, expect } from './helpers/orca-app'`. Copy the programmatic open from `tests/e2e/csv-table-editing.spec.ts` (`updateSettings` + `openFile` on `window.__store`). Do not steal focus; the headless project stays hidden.

Fixture file contents exactly `hello\n`, `editorAutoSave: false`, `editorKeybindings: 'vim'`.

1. `[data-vim-status]` text includes `--NORMAL--`.
2. Click `.monaco-editor`, press `x`. Editor value is `ello\n`, not `xhello\n`. Read it from `window.__monacoEditorE2E.snapshot().valueTail` or the model via the probe's value length plus a page evaluate of the editor value. The probe is installed only when `import.meta.env.MODE === 'e2e'`, which this project sets.
3. Press `i`, then `Z`, then `Escape`. Status includes `--NORMAL--`. Value is `Zello\n`. `snapshot().canUndo` is true.
4. Press `ControlOrMeta+s`. On-disk file is `Zello\n`. Then press `o`, `Escape` (opens a line below), type `:w`, Enter. On-disk file matches the editor value, and it is not the pre-`:w` contents. That separates `:w` from the Save chord.
5. Press `ControlOrMeta+f`. `.find-widget` is visible (`aria-hidden` not `true`). Press `Escape`. Widget `aria-hidden` is `true`, and status still includes `--NORMAL--`.
6. `updateSettings({ editorKeybindings: 'default' })` without closing the tab. Status row count is 0. `snapshot().canUndo` is still true. Press `q`. Value ends with `q` (Default insert). Press `ControlOrMeta+z`. The `q` is gone and `Zello` remains, proving the vim edit's undo stack survived the toggle.

`pnpm tc` for the new shared type and the dynamic import. Do not claim the feature works if step 2 still inserts `x`; apply step 7 and re-run this spec.

## Assumptions & contingencies

- Scope locked to Default/Vim plus library motions/operators/visual/search and `:w` only. `:q` / `:wq` / `:set` / a cheatsheet are not an implementer option; they need tab-close and settings-desync decisions this delivery does not make.
- Combined diffs, the original diff pane, auto-height previews, rich Markdown, terminals, and read-only views are not attached. Writable conflict editors that already render `MonacoEditor` with `autoHeight={false}` and `readOnly={false}` get Vim through step 4 with no extra surface code.
- If `monaco-vim@0.4.4` cannot be made to attach by step 7's dedupe then alias, stop. Default keybindings stay usable. Do not replace the dependency with a custom engine.
