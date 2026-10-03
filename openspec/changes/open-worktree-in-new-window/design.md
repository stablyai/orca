## Context

Current architecture: single Electron window (`createMainWindow`) loads all worktrees via sidebar selection. State changes (activeWorktreeId) update within that window. No multi-window support exists.

Required capabilities: see specs/multi-window and specs/window-registry.

## Goals

- Enable launching independent windows, each with its own worktree
- Isolate window state (activeWorktreeId, terminal tabs, UI scroll) per window
- Persist window layout (which worktree in which window) across restarts
- Support same worktree in multiple windows concurrently
- Minimize changes to existing single-window code paths

## Non-Goals

- Window docking/tiling (user positions manually)
- Synchronized scrolling between windows
- Drag-drop worktrees between windows (future)
- Window snapshots/named layouts (future)

## Decisions

### Decision: Window State Isolation
**Approach**: Each window maintains independent `activeWorktreeId` in its renderer store.

**Rationale**: Renderer state is window-scoped by nature (localStorage, store). Centralizing state in main process would require heavy IPC for every state change.

**Alternatives Considered**:
- Centralized state in main process: Higher IPC overhead, added latency for every state update
- Shared Electron SharedPreferences: Not available for runtime state

### Decision: Shared Git Config via Existing Wrapper
**Approach**: Reuse existing git command wrapper in main process; both windows call through it.

**Rationale**: No need to duplicate git logic. The wrapper already handles per-host config (local, WSL, SSH). Both windows use same execution infrastructure.

**Alternatives Considered**:
- Sync config per-window: Unnecessary duplication
- Cache config in renderer: Would diverge from source of truth

### Decision: Window Registry in Main Process
**Approach**: Simple in-memory Map<windowId, worktreeId>; also save to file for persistence.

**Rationale**: Main process owns window lifecycle. Registry needed for:
- Tracking which windows exist (prevents zombie windows)
- Cleanup on window close
- Persisting layout to re-open on restart

**Alternatives Considered**:
- Distributed registry (each window knows itself): No central cleanup on crash
- Database: Overkill for this data volume

### Decision: Window Persistence Strategy
**Approach**:
1. On app exit: Save list of (windowId, worktreeId, position, size)
2. On app startup: Restore windows in saved state
3. On window close: Remove from list and re-save
4. Handle missing/deleted worktrees gracefully (fallback to default)

**Rationale**: Users expect windows to restore after restart (Electron standard). Fallback prevents crashes if worktree deleted between sessions.

**Alternatives Considered**:
- Per-window session files: Complexity managing multiple files; harder to clean up
- In-memory only: Lost on restart, poor UX

### Decision: IPC Handler for New Window
**Approach**: New channel `worktree:open-in-new-window` called from renderer context menu.

**Rationale**: Renderer (UI) detects user action; main process owns windows. IPC is clean separation of concerns.

**Alternatives Considered**:
- Pass worktreeId as URL param: Fragile, doesn't hide window creation from renderer
- Native module: Overkill, IPC sufficient

### Decision: Window Initialization Hook
**Approach**: New hook `use-window-init` in renderer that reads initialWorktreeId from context and activates it on mount.

**Rationale**: Cleanly separates window-opening concern from main App component. Uses existing activation logic.

**Alternatives Considered**:
- Modify App component directly: Couples window-opening to app initialization
- Store in sessionStorage: Race condition with store initialization

## Architecture Diagram

```
┌─ Main Process ──────────────────────────────────┐
│                                                  │
│  ┌─ createMainWindow(initialWorktreeId) ──┐   │
│  │ • Create BrowserWindow                 │   │
│  │ • Pass initialWorktreeId to renderer   │   │
│  └─────────────────────────────────────────┘   │
│                                                  │
│  ┌─ WindowRegistry ───────────────────────┐   │
│  │ • Map<windowId → worktreeId>          │   │
│  │ • register(windowId, worktreeId)      │   │
│  │ • deregister(windowId)                │   │
│  │ • getWindows(worktreeId) → [ids]     │   │
│  └─────────────────────────────────────────┘   │
│                                                  │
│  ┌─ WindowPersistence ────────────────────┐   │
│  │ • saveState([{windowId, wt, pos}])   │   │
│  │ • loadState() → [{...}]              │   │
│  └─────────────────────────────────────────┘   │
│                                                  │
│  ┌─ IPC: worktree:open-in-new-window ──┐   │
│  │ input: {worktreeId, workspaceKey}    │   │
│  │ → openMainWindow(worktreeId)         │   │
│  └─────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
                      ↕
┌─ Renderer (each window independent) ───────────┐
│                                                  │
│  ┌─ use-window-init hook ─────────────────┐   │
│  │ • Reads initialWorktreeId from context │   │
│  │ • Calls activateAndRevealWorktree()   │   │
│  └─────────────────────────────────────────┘   │
│                                                  │
│  ┌─ WorktreeOpenInMenu ───────────────────┐   │
│  │ • Context menu "Open in New Window"   │   │
│  │ • Calls ipc.invoke(...)               │   │
│  └─────────────────────────────────────────┘   │
│                                                  │
│  ┌─ Store (per-window) ───────────────────┐   │
│  │ • activeWorktreeId (isolated)         │   │
│  │ • Terminal tabs, UI state             │   │
│  └─────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
```

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Window state explosion (10+ windows) | UI limit or warn user; lazy load persistence |
| IPC bottleneck (multiple windows + git) | Use existing `git-command` queue; it already handles concurrency |
| State corruption on crash | Recovery logic: ignore corrupted entry, continue with others |
| SSH delay on window open | Add timeout to initialization; fallback to default |
| Worktree deleted between sessions | Graceful fallback: open default worktree instead |
| Window.on('closed') fires but process doesn't exit | App.on('window-all-closed') handler ensures exit |

## Migration Plan

**Phase 1**: Extend window creation API, add registry, persistence layer
**Phase 2**: Add IPC handler, renderer menu item, initialization hook
**Phase 3**: Implement tests
**Phase 4**: Deploy (no breaking changes; feature is additive)

**Rollback**: Remove feature flag / revert feature branch; single-window workflows unaffected

## Open Questions

- Should we add a soft limit (max 5 windows)? Defer to post-launch usage data.
- Should we add "remember my window layout" feature? Out of scope; future enhancement.
- Should we warn users if same worktree opened in multiple windows? Defer until we see user patterns.
