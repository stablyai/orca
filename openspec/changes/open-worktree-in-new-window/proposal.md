## Why

Users currently work with one worktree at a time, switching via sidebar selection. Multi-worktree workflows require constant context-switching, and users with multiple monitors can't utilize them effectively. This feature enables side-by-side work on different worktrees, improving productivity for teams handling multiple projects simultaneously.

## What Changes

- **UI**: Add "Open in New Window" menu item to worktree context menu
- **Architecture**: Implement multi-window support with independent window state and shared git config
- **IPC**: New channel `worktree:open-in-new-window` to spawn windows from renderer
- **Persistence**: Save and restore window layout (which worktree in which window) on app restart
- **Behavior**: Each window operates independently; closing one doesn't affect others; app exits when last window closes

## Capabilities

### New Capabilities
- `multi-window`: User can open worktrees in independent Electron windows for concurrent multi-worktree work. Includes window lifecycle, state isolation, persistence, and cleanup.
- `window-registry`: Track open windows and their associated worktrees; manage cleanup on close.

### Modified Capabilities
- (None — no existing capability requirements are changing; this is purely additive)

## Impact

**Code areas**:
- `src/main/window/` — window creation, registry, persistence
- `src/main/ipc/` — new handler for opening windows
- `src/main/preload.ts` — expose IPC bridge
- `src/renderer/src/components/sidebar/` — add menu item
- `src/renderer/src/hooks/` — window initialization

**APIs**: New IPC channel `worktree:open-in-new-window`; extended window creation API

**User-facing**: Multi-monitor workflows, concurrent project work, better UX for teams

**Dependencies**: None new; uses existing Electron window management and git command wrapper
