## Purpose

Enables users to open worktrees in independent Electron windows for concurrent multi-worktree workflows on multi-monitor setups.

## ADDED Requirements

### Requirement: User can open worktree in new window from menu
The system SHALL display a "Open in New Window" option in the worktree context menu that, when invoked, spawns a new Electron window pre-loaded with that worktree.

#### Scenario: User opens worktree from context menu
- **WHEN** user right-clicks a worktree in the sidebar
- **THEN** context menu appears with "Open in New Window" option
- **WHEN** user clicks "Open in New Window"
- **THEN** new Electron window appears with the selected worktree active and terminal ready

### Requirement: Windows operate independently
The system SHALL maintain independent state for each window; switching worktrees in one window does NOT affect other windows.

#### Scenario: Separate workspaces in two windows
- **WHEN** window A shows worktree-1 and window B shows worktree-2
- **WHEN** user switches to a different worktree in window B
- **THEN** window A still shows worktree-1 without change

### Requirement: Window closure is isolated
The system SHALL allow closing individual windows without terminating the application; closing one window does NOT close others.

#### Scenario: Close one of two windows
- **WHEN** two windows are open (worktree-1 and worktree-2)
- **WHEN** user closes window B
- **THEN** window A remains open and functional
- **AND** application continues running

### Requirement: App exits when all windows close
The system SHALL terminate the application when the last window closes.

#### Scenario: Close final window
- **WHEN** only one window is open
- **WHEN** user closes that window
- **THEN** application exits

### Requirement: Window state persists across restarts
The system SHALL save the list of open windows and their associated worktrees, and restore them on app startup.

#### Scenario: Restore windows after restart
- **WHEN** user has windows A (worktree-1) and B (worktree-2) open
- **WHEN** user closes and restarts the application
- **THEN** both windows are restored in their previous positions
- **AND** each window shows its correct worktree

### Requirement: Git operations work across windows
The system SHALL execute git commands in each window on its own worktree without interference between windows.

#### Scenario: Run git commands in two windows simultaneously
- **WHEN** user runs `git status` in window A (worktree-1)
- **AND** user runs `git status` in window B (worktree-2)
- **THEN** both commands execute successfully
- **AND** each returns status for its own worktree

### Requirement: Same worktree can be open in multiple windows
The system SHALL allow opening the same worktree in multiple windows concurrently.

#### Scenario: Open same worktree in two windows
- **WHEN** user opens worktree-1 in window A
- **AND** user opens worktree-1 in window B
- **THEN** both windows display the same worktree
- **AND** each window maintains independent UI state (scrolls, tabs, terminal history)

### Requirement: SSH worktrees work transparently
The system SHALL support opening SSH-based worktrees in new windows with the same execution model as the main window.

#### Scenario: Open SSH worktree in new window
- **WHEN** user opens an SSH-based worktree in a new window
- **WHEN** user runs a git command in that window
- **THEN** command executes on the SSH host
- **AND** execution behavior matches the main window
