# Open In Menu Item on Worktrees

## Scope

Add an `Open in` item to the worktree context menu for local worktree paths.

Actions:

- VS Code (directory target)
- Open in OS file manager (directory reveal/open)

Blocked:

- Any SSH-backed worktree (`repo.connectionId` set)
- Any non-local runtime context (`activeRuntimeEnvironmentId` set)

Use `VS Code` as the visible editor label. Keep implementation identifiers generic so launcher behavior can evolve without renaming APIs.

## Current State (Code-Verified)

- `WorktreeContextMenu.tsx` has `Open in Finder` (macOS-specific label) and calls `window.api.shell.openPath(worktree.path)`.
- `shell:openPath` in `src/main/ipc/shell.ts` calls `shell.showItemInFolder(path)` directly with no absolute-path validation, no existence check, and no structured return.
- Preload contract exposes `openPath/openFilePath/openFileUri` as `Promise<void>`.
- `isLocalPathOpenBlocked` exists and is tested (`local-path-open-guard.test.ts`), but enforcement is renderer-side only.
- `shell.test.ts` currently does not test `shell:openPath`, `shell:openFilePath`, or `shell:openFileUri` behavior.

## Required Design Changes

### 1) IPC: split intent, return structured results

Add explicit IPC handlers (main + preload + type contract):

- `shell:openInFileManager(path)`
- `shell:openInExternalEditor(path)`

Return:

- `{ ok: true }`
- `{ ok: false, reason: 'not-absolute' | 'not-found' | 'launch-failed' }`

Why: `Promise<void>` hides failures and forces renderer to assume success.

### 2) Main-process validation must be authoritative

For both new handlers:

- Normalize path.
- Require absolute path.
- Check existence at call time (`stat`).
- Map launcher failure to `launch-failed`.

Renderer checks are UX only; security/correctness must not depend on renderer state.

### 3) External editor launch must be feasible and generic

Launch a generic editor CLI command constant with the normalized directory path as an argv entry.

Important correction: do not claim this uses the OS default app for a directory. The launcher is platform-dependent and may fail per host config; failure must be surfaced via result union + toast.

### 4) File manager action semantics

Keep file-manager action separate from editor action.

Platform-aware label in renderer:

- macOS: `Finder`
- Windows: `File Explorer`
- Linux: `File Manager`

If using reveal semantics, document that behavior explicitly and keep it consistent in the context menu.

### 5) UI integration

- Add a reusable sidebar open-in menu component used by `WorktreeContextMenu`.
- The context menu should show a single `Open in` item with nested choices for VS Code and OS file manager.

Interaction constraints:

- Disable while deleting (`isDeleting`).
- Preserve existing keyboard/focus behavior of menu primitives.

### 6) Remote/SSH blocking policy

Keep existing `isLocalPathOpenBlocked` gate in renderer for immediate UX and consistent toasts.

Policy nuance:

- Continue blocking by runtime/SSH context (existing behavior).
- Main process still validates path existence/shape for all requests.
- If later hardening is needed, add connection/runtime provenance in IPC args and enforce remote block in main too.

## Edge Cases That Must Be Explicitly Handled

- Worktree deleted/moved between render and click: return `not-found`.
- Multi-window stale data: each click is independently validated in main.
- Rapid repeated clicks: requests are independent; no Orca-side dedupe required.
- External FS mutation races: normalized absolute path + existence recheck per call.
- Host launcher missing/misconfigured: return `launch-failed`, show actionable toast.

## Testing Requirements

### `src/main/ipc/shell.test.ts`

Add tests for both new handlers:

- rejects relative path (`not-absolute`)
- rejects missing path (`not-found`)
- maps launcher error/failure (`launch-failed`)
- success path invokes expected Electron shell call

Also add coverage for existing `shell:openFilePath`/`shell:openFileUri` failure branches if retained.

### Renderer tests

Add/adjust tests near sidebar components for:

- submenu disabled state while deleting
- blocked-path toast path
- platform label mapping

## Rollout Order

1. Add new main IPC handlers + result union types in preload contract.
2. Add shared sidebar open-in menu component and wire into context menu.
3. Replace direct `openPath` usage for worktree actions with new handlers.
4. Add tests and run targeted test/typecheck.

## Non-goals

- Editor picker UI
- Per-worktree app preference
- Enabling local OS open for SSH/remote runtime worktrees
