# Open Worktree in New Window

## Purpose

Enable users to open worktrees in independent Electron windows, allowing side-by-side multi-window workflows for improved productivity and multi-monitor support.

## Requirements

### Requirement: User can open worktree in new window from context menu
Users SHALL be able to right-click a worktree and select "Open in New Window" to launch that worktree in a separate Electron window.

#### Scenario: Open worktree from sidebar menu
- **WHEN** user right-clicks a worktree in the sidebar
- **THEN** context menu appears with "Open in New Window" option
- **WHEN** user clicks "Open in New Window"
- **THEN** new Electron window spawns
- **AND** new window pre-loads the selected worktree
- **AND** terminal is ready for commands

### Requirement: Multiple windows work independently
Users SHALL be able to work on different worktrees simultaneously, with each window maintaining independent state.

#### Scenario: Two windows with different worktrees
- **WHEN** worktree A is open in main window
- **AND** user opens worktree B in a new window
- **THEN** both windows are visible and functional
- **AND** switching tabs in window B doesn't affect window A
- **AND** closing window B doesn't affect window A

### Requirement: Window state persists across app restarts
Users SHALL see previously open windows restored with their respective worktrees when restarting the app.

#### Scenario: Restore windows on app startup
- **WHEN** user has 2 windows open (worktree A and B)
- **AND** user closes and restarts the app
- **THEN** both windows are restored with correct worktrees
- **AND** windows appear in same positions as before

### Requirement: Git operations work across windows
Users SHALL be able to run git commands in any window, executing on the correct host.

#### Scenario: Git commands in multiple windows
- **WHEN** user runs `git status` in both windows
- **THEN** each window executes on its own worktree
- **AND** commands succeed without interference

## Architecture

### Window Lifecycle

```
[Window A]              [Window B]
├── worktree-1         ├── worktree-2
└── activeWorktreeId   └── activeWorktreeId
   (independent)          (independent)

[Main Process]
├── Window Registry (windowId ↔ worktreeId)
├── Window Persistence (save/restore layout)
└── IPC Router
```

### State Management

| Type | Scope | Mechanism |
|------|-------|-----------|
| **Per-Window** | activeWorktreeId, terminal tabs, UI state | Isolated in each renderer |
| **Shared** | Git config, auth tokens | Synced via IPC from main |

### IPC Contract

```typescript
// Renderer → Main
ipc.invoke('worktree:open-in-new-window', {
  worktreeId: string;
  workspaceKey: string;
})

// Returns
{ success: boolean; windowId?: number; error?: string }
```

## Behavior

### Opening New Window

1. User clicks "Open in New Window" menu item
2. Renderer calls `window.api.worktrees.openInNewWindow(worktreeId)`
3. Main process calls `openMainWindow(initialWorktreeId)`
4. New BrowserWindow created + renderer loads
5. Renderer initializes with worktree active
6. Window ID + worktree ID stored in registry

### State Synchronization

- **Git Config**: Uses existing `git-command.ts` wrapper (already per-host)
- **Auth/Tokens**: Each window manages own `localStorage`
- **Worktree List**: Global (both windows see same list)

### Cleanup & Lifecycle

- On window close → removed from registry
- App exits only when all windows closed
- On restart → restore all windows with their worktrees

## Implementation Requirements

### Backend (Main Process)

| File | Change | Lines |
|------|--------|-------|
| `src/main/window/createMainWindow.ts` | Add `initialWorktreeId` param | 10-15 |
| `src/main/startup/main-window-controller.ts` | Add `openMainWindowForWorktree()` | 20-30 |
| `src/main/ipc/worktrees.ts` | Register `worktree:open-in-new-window` handler | 15-20 |
| `src/main/window/window-registry.ts` (new) | Track window ↔ worktree mapping | 50-100 |
| `src/main/window/window-persistence.ts` (new) | Save/restore state | 60-80 |
| `src/main/ipc/window-state.ts` (new) | Window state IPC handlers | 30-40 |
| `src/main/preload.ts` | Expose `window.api.worktrees.openInNewWindow()` | 5-10 |

**Total**: ~200-280 lines

### Frontend (Renderer)

| File | Change | Lines |
|------|--------|-------|
| `src/renderer/src/components/sidebar/WorktreeOpenInMenu.tsx` | Add menu item + handler | 30-45 |
| `src/renderer/src/hooks/use-window-init.ts` (new) | Initialize with worktreeId | 20-30 |
| `src/renderer/src/App.tsx` | Call init hook | 5-10 |

**Total**: ~70-100 lines

### Tests

| File | Cases | Lines |
|------|-------|-------|
| `src/main/ipc/__tests__/worktree-new-window.spec.ts` | IPC validation (6) | 40-50 |
| `src/main/window/__tests__/window-registry.spec.ts` | Registry ops (11) | 50-70 |
| `src/main/window/__tests__/window-persistence.spec.ts` | Persist/recover (8) | 40-50 |
| `src/renderer/.../WorktreeOpenInMenu.spec.tsx` | UI interaction (4) | 30-40 |
| `e2e/__tests__/open-worktree-in-new-window.e2e.ts` | Full flow (15+) | 60-80 |

**Total**: ~220-290 lines

## Success Criteria

- ✅ IPC handler invoked successfully
- ✅ New window created with correct worktree
- ✅ Both windows independent (state doesn't sync)
- ✅ Closing one doesn't affect the other
- ✅ Window state persisted across restarts
- ✅ All tests pass
- ✅ Works on macOS, Windows, Linux
- ✅ No memory leaks (3+ windows)
- ✅ SSH execution works

## Edge Cases Handled

| Case | Resolution |
|------|-----------|
| Same worktree in 2 windows | Allowed |
| Worktree deleted | Fallback to default |
| Corrupted state file | Start with default |
| Rapid window opens | Graceful queuing |
| Window crash | Others unaffected |

## Decisions

| Question | Answer |
|----------|--------|
| Can same worktree be in 2 windows? | ✅ Yes |
| App exit when last window closed? | ✅ Standard Electron behavior |
| Restore windows on restart? | ✅ Yes |
| SSH worktrees? | ✅ Supported transparently |
| Max windows? | No hard limit (future: soft limit) |

## Dependencies

- Existing worktree activation (`worktree-activation.ts`)
- Existing IPC infrastructure
- Git command wrapper (handles hosts)
- Electron window management

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Window state explosion | Add UI limit (max 5 windows) |
| IPC bottleneck | Use existing `git-command` queue |
| State corruption on crash | Recovery logic in persistence |
| SSH delays | Timeout + fallback |
