# Design Document: External File Drop Import in File Explorer

## 1. Overview

Orca's file explorer already supports drag-and-drop for moving items that originate inside the explorer, but it does not support dropping files or folders from the OS into the explorer to add them to the active worktree.

This document proposes a native file-drop import flow that works in both places users expect:

- Dropping onto the explorer background imports into the worktree root.
- Dropping onto a directory row imports into that directory.
- Dropping onto a file row imports into that file's parent directory.

The design follows the same high-level split used by VS Code: external/native drops are handled as imports, while in-explorer drags remain move operations. Superset is a useful reference for renderer-side drag-state handling: it treats `Files` drags as a distinct UX path with explicit hover state instead of trying to force them through the in-app DnD codepath.

## 2. Goals

- Let users drop external files and folders from Finder/Explorer/Linux file managers into Orca's file explorer.
- Support root-level drops and nested directory drops.
- Preserve the current in-explorer move behavior for `text/x-orca-file-path`.
- Keep the implementation cross-platform across macOS, Linux, and Windows.
- Avoid destructive overwrites by default.
- Keep the import path performant for large multi-file and directory drops.

## 3. Non-Goals

- No drag-out export from Orca to the OS.
- No cross-worktree move semantics for external drops. External drops always copy/import.
- No full upload/progress manager in v1.
- No overwrite prompt flow in v1.

## 4. Current State

Today the relevant pieces are split across three layers:

- `src/renderer/src/components/right-sidebar/useFileExplorerDragDrop.ts` and `FileExplorerRow.tsx` handle only internal explorer drags via `text/x-orca-file-path`, and complete the action with `window.api.fs.rename(...)`.
- `src/preload/index.ts` intercepts native OS drops before React sees them and classifies them only as `editor` or `terminal`.
- `src/renderer/src/hooks/useGlobalFileDrop.ts` opens dropped files in the editor, while terminal panes insert dropped paths into the active PTY.

That means the explorer never receives a native-drop route, and there is no filesystem API that copies a dropped file tree into the worktree.

## 5. Reference Behavior

### 5.1 VS Code

VS Code explicitly separates:

- native drag/drop import (`NativeDragAndDropData` -> `ExternalFileImport.import(...)`)
- in-explorer drag/drop move/copy (`handleExplorerDrop(...)`)

The important design takeaway is not the exact API shape. It is that external drops resolve a destination directory first and then run an import pipeline instead of trying to reuse the internal move path.

### 5.2 Superset

Superset's desktop app uses renderer-side `onDragOver` / `onDragLeave` / `onDrop` handling keyed off `e.dataTransfer.types.includes("Files")`, with explicit hover UI and defensive `getPathForFile(...)` handling.

The useful precedent for Orca is the UX structure:

- treat native file drags as their own interaction mode
- show a clear copy/import affordance
- clear drag state reliably on `drop` and `dragend`

## 6. Proposed UX

When the user drags external files over the file explorer:

- The explorer root shows a copy/import highlight when the drop target is the worktree root.
- Directory rows highlight as valid copy targets.
- Hovering a collapsed directory during a native drag auto-expands it after the same delay used for internal moves.
- The cursor uses `dropEffect = "copy"`.

The explorer root drop surface must remain available even when the tree is empty, still loading, or showing a read error. In v1, the right sidebar should keep rendering a root-level explorer container for those states so users can still drop into the worktree root instead of losing the target entirely.

This requires restructuring the current early-return branches in `FileExplorer.tsx`. Today the component returns dedicated loading / error / empty placeholders before it renders the shared `ScrollArea`, so adding dataset markers only to the existing populated-tree path would still leave root import unavailable in those states.

When the user drops:

- On explorer background: import into the worktree root.
- On directory row: import into that directory.
- On file row: import into the parent directory.

In v1, "inside the folder" means dropping on that folder's row. Orca's explorer is a virtualized flat list rather than nested DOM containers, so arbitrary whitespace under a folder's rendered children is not treated as a separate interior drop zone.

After completion:

- Refresh the destination directory.
- Reveal and flash the first imported path.
- Show a summary toast, for example `Imported 3 items to src/components`.

The explorer should not auto-open dropped files in v1. Dropping into the explorer is an "add here" action, not an "open in editor" action.

## 7. Architecture

### 7.1 Extend Native Drop Routing

Add a third native-drop target in preload:

- `editor`
- `terminal`
- `file-explorer`

The current `getNativeFileDropTarget(...)` helper in `src/preload/index.ts` should become a richer resolver that walks `event.composedPath()` and extracts:

- the high-level target kind
- the nearest explorer destination directory, if any

The explorer DOM should expose two dataset markers:

- `data-native-file-drop-target="file-explorer"` on the root scroll area
- `data-native-file-drop-dir="<absolute dir path>"` on the root container and on each row drop target

Routing must fail closed for explorer drops. If preload sees `data-native-file-drop-target="file-explorer"` but cannot resolve a `destinationDir`, it should reject the gesture and emit no fallback `editor` drop event.

Why this is necessary: the preload layer consumes native OS `drop` events before React can read filesystem paths. If preload does not capture the destination directory at drop time, the renderer can no longer tell whether the user meant "root" or "inside this folder".

The relayed payload should become:

```ts
type NativeFileDropEvent =
  | { paths: string[]; target: 'editor' }
  | { paths: string[]; target: 'terminal' }
  | { paths: string[]; target: 'file-explorer'; destinationDir: string }
```

Preload/main must emit exactly one native-drop event per drop gesture.

Why: the preload layer already has the full `FileList`. Re-emitting one IPC message per path and asking the renderer to reconstruct the gesture via timing would be both fragile and slower under large drops.

**Impact on existing listeners:**
Because the relay payload changes from `{ path: string }` to `{ paths: string[] }`, existing `ui.onFileDrop` handlers in:
- `src/renderer/src/hooks/useGlobalFileDrop.ts` (editor target)
- `src/renderer/src/components/terminal-pane/use-terminal-pane-global-effects.ts` (terminal target)
must be updated to loop over the `paths` array.

### 7.2 Renderer Explorer Drag State

`useFileExplorerDragDrop(...)` should handle two drag families:

- internal Orca drags: `text/x-orca-file-path`
- external/native drags: `Files`

The existing move logic stays unchanged for internal drags.

For native drags, the hook should:

- accept `Files` in root and row `onDragOver`
- set copy affordance and hover state
- reuse the existing row auto-expand timer for directory targets
- clear root/row highlight on `dragleave`, `dragend`, and after the import event fires

The hook should use the same explicit destination model as the drop router:

- root background -> worktree root
- directory row -> that directory
- file row -> file's parent directory

This follows Superset's approach of treating external drags as a distinct renderer interaction, even though the final import action is triggered from the preload-delivered event instead of the React `drop` handler.

### 7.3 New Filesystem Import IPC

Add a dedicated filesystem mutation:

```ts
window.api.fs.importExternalPaths({
  sourcePaths: string[],
  destDir: string
}): Promise<{
  results: Array<
    | {
        sourcePath: string
        status: 'imported'
        destPath: string
        kind: 'file' | 'directory'
        renamed: boolean
      }
    | {
        sourcePath: string
        status: 'skipped'
        reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported'
      }
    | {
        sourcePath: string
        status: 'failed'
        reason: string
      }
  >
}>
```

Implementation lives alongside the existing filesystem mutations in `src/main/ipc/filesystem-mutations.ts`.

Behavior:

1. Authorize every source path with the existing external-path mechanism.
2. Validate every source path from its unresolved path using `lstat(...)` before any canonicalization so top-level symlinks are rejected instead of being silently dereferenced by `realpath(...)`.
3. Resolve `destDir` through `resolveAuthorizedPath(...)`.
4. Copy, never rename.
5. Support both files and directories.
6. Return per-top-level-item results so the renderer can produce correct summary UX for success, partial success, and renames.

### 7.4 Copy Semantics

Use recursive copy semantics in the main process:

- File source: copy file bytes.
- Directory source: create the top-level directory, then recursively copy descendants.

This should be implemented in Node-side filesystem code, not in the renderer, so path authorization and cross-platform behavior stay centralized.

### 7.5 Atomic Import Rules

Directory imports must be atomic at the top-level item boundary.

Required behavior:

- Before importing a dropped directory, pre-scan that directory tree for disallowed entries such as symlinks.
- Source validation must inspect the dropped path itself with `lstat(...)` before calling helpers like `resolveAuthorizedPath(...)` that canonicalize existing paths.
- If the pre-scan finds a disallowed entry, skip that top-level source entirely.
- Do not create any destination files or directories for a top-level source that fails pre-scan.

Why: if recursive copy discovers a symlink halfway through, Orca would otherwise leave a partially imported tree behind. Pre-scan is the preferred v1 design because it is simpler and more performant than temp-directory staging while still avoiding partial output.

## 8. Conflict Policy

v1 should be non-destructive and prompt-free:

- Never overwrite an existing file or folder.
- If a top-level dropped item collides with an existing name in `destDir`, generate a unique sibling name before copying.

Examples:

- `logo.png` -> `logo copy.png`
- `logo.png` -> `logo copy 2.png`
- `assets/` -> `assets copy/`

This matches Orca's current bias toward safe filesystem mutations and avoids blocking the drop on a modal confirmation flow.

Top-level deconfliction is sufficient for dropped directories because the copy target becomes a newly created directory. Once that top-level directory name is unique, nested collisions disappear inside that subtree.

If multiple dropped items collide with each other, the same deconfliction pass should run against the union of:

- already existing destination entries
- names reserved earlier in the same import batch

The result payload must preserve whether each successful import was renamed by deconfliction.

## 9. Symlink Policy

Reject symlinks in v1.

Rationale:

- Symlink copy semantics differ across platforms.
- Copying a symlink literal can produce confusing repository state.
- Following symlinks can escape the dropped subtree and import unintended content.

If a dropped source or descendant is a symlink, fail that top-level item and surface a toast summary such as `Skipped 1 item containing symlinks`.

## 10. Renderer Flow

The renderer-side import path should be:

1. `window.api.ui.onFileDrop(...)` receives one gesture-scoped event: `{ target: 'file-explorer', paths, destinationDir }`.
2. The explorer calls `window.api.fs.importExternalPaths({ sourcePaths: paths, destDir: destinationDir })`.
3. On success or partial success, it calls `refreshDir(destinationDir)` once.
4. It reveals and flashes the first successfully imported destination path, if any, by routing through Orca's existing expansion-aware reveal pipeline (`pendingExplorerReveal` / `useFileExplorerReveal`) or an equivalent mechanism that can expand collapsed ancestors before selecting the imported path.
5. It clears drag state and shows one summary toast derived from the returned per-item results.

## 11. Error Handling

Failure modes should be explicit but non-destructive:

- Source path no longer exists: skip and report.
- Permission denied: fail the affected item and report.
- Unsupported symlink: skip and report.
- Destination path unauthorized: fail the whole import.

Toast copy should summarize, not spam:

- Success: `Imported 5 items to src`
- Partial: `Imported 4 items to src. 1 item was skipped.`
- Failure: `Could not import dropped items`

The renderer should derive these counts from the returned result payload rather than inferring them from thrown exceptions.

## 12. Watcher and Refresh Strategy

The filesystem watcher in `useFileExplorerWatch.ts` is a useful backstop, but the import flow should still refresh explicitly after completion.

Why: native drops can create many files quickly, and the UX should not depend on watcher timing to make the destination directory show the new content.

The minimal explicit refresh is:

- `refreshDir(destinationDir)` after import

If imported content lands under directories that were already expanded, the watcher can reconcile the rest.

## 13. Performance

Performance is a core requirement for this feature.

### 13.1 Event Routing

- Preload should extract the native `FileList` once and relay one IPC event per drop gesture.
- The renderer should not do timer-based gesture reconstruction or emit one IPC call per dropped path.

### 13.2 Main-Process Import

- Import work must stay in the main process so the renderer remains responsive.
- The copy path should use native filesystem copy primitives or streaming I/O, not `readFile()` buffering whole files into memory.
- Pre-scan should walk dropped directories once per top-level source to detect symlinks before copy starts.
- Top-level deconfliction should happen once per dropped source before the copy loop, avoiding repeated deep-path collision checks.

### 13.3 UI Updates

- The renderer should call `refreshDir(destinationDir)` once per completed gesture.
- The renderer should emit one summary toast per gesture.
- The renderer should reveal only the first successful import rather than forcing multiple scroll/reveal passes.

### 13.4 Scope Control

To keep v1 fast and predictable, it should not include per-file progress rows, per-item toasts, or overwrite prompts inside the copy loop.

## 14. Testing

### 14.1 Preload / Main

- target resolution picks `file-explorer` when the composed path contains explorer markers
- nearest `data-native-file-drop-dir` wins over outer containers
- relay payload includes `destinationDir`
- relay emits one event containing all dropped `paths`
- file-explorer routing fails closed when the target marker is present but `destinationDir` is missing
- editor-target drops still open every dropped file from the single gesture payload
- terminal-target drops still insert every dropped path from the single gesture payload

### 14.2 Filesystem Mutation Tests

- imports a single file
- imports multiple files in one batch
- imports a directory recursively
- deconflicts top-level filename collisions
- deconflicts top-level directory collisions
- rejects top-level symlink sources before canonicalization
- skips a dropped directory with nested symlinks without leaving partial output
- rejects unauthorized destinations
- returns per-item results including rename metadata

### 14.3 Renderer Tests

- root drop surface remains active while the explorer is empty, loading, or showing a root read error
- root highlight appears for `Files` drag
- directory rows highlight and auto-expand for `Files` drag
- file rows map to parent directory targets
- one drop gesture triggers one import IPC call
- one drop gesture produces one summary toast
- success reveals the first imported destination path
- success reveal still works when the imported path lives under ancestors that were collapsed before the drop

## 15. Implementation Plan

1. Extend native-drop typing and relay payload in preload/main to send one event per drop gesture with `paths[]`.
2. Update existing editor and terminal `ui.onFileDrop` handlers in the renderer to accept `paths[]`.
3. Refactor `FileExplorer.tsx` so the shared root explorer container stays mounted for loading, error, and empty states, then add explorer DOM markers for root and per-row destination directories.
4. Teach `useFileExplorerDragDrop(...)` to track native `Files` drag state separately from internal move state.
5. Add `fs.importExternalPaths(...)` to preload typings and main IPC with a per-item result schema.
6. Implement pre-scan + recursive copy + top-level deconfliction + symlink rejection in `filesystem-mutations.ts`.
7. Wire the explorer import success path through the existing expansion-aware reveal flow so drops into collapsed folders still reveal correctly.
8. Add renderer import handling, refresh, reveal, and one-toast-per-gesture summary handling.
9. Add tests across preload, IPC, and renderer.

## 16. Open Questions

- Whether v2 should support an overwrite confirmation flow like VS Code instead of prompt-free deconfliction.
- Whether v2 should show progress UI for large directory imports.
- Whether symlink rejection should later become a user-visible choice for trusted repos.
