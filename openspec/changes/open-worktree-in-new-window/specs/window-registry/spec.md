## Purpose

Tracks active windows and their associated worktrees, enabling proper lifecycle management and cleanup.

## ADDED Requirements

### Requirement: Window registration on creation
The system SHALL register each new window with its associated worktree ID when created.

#### Scenario: Register window after creation
- **WHEN** new window is created for worktree-1
- **THEN** system internally registers windowId → worktree-1 mapping
- **AND** registry can query windows by worktreeId

### Requirement: Window deregistration on close
The system SHALL remove window from registry when it closes.

#### Scenario: Deregister window on close
- **WHEN** window is registered in the registry
- **WHEN** window closes
- **THEN** system removes windowId → worktreeId mapping from registry
- **AND** subsequent queries return no window for that ID

### Requirement: Query windows by worktree
The system SHALL support querying all windows associated with a given worktree.

#### Scenario: Find all windows for a worktree
- **WHEN** same worktree is open in two windows (windowId: 1, 3)
- **WHEN** registry is queried for worktreeId
- **THEN** registry returns [1, 3]

### Requirement: Query worktree by window
The system SHALL support querying which worktree is open in a given window.

#### Scenario: Lookup worktree in a window
- **WHEN** windowId 5 is registered with worktree-2
- **WHEN** registry is queried for windowId 5
- **THEN** registry returns worktree-2

### Requirement: Handle orphaned windows gracefully
The system SHALL gracefully handle cases where a window closes without cleanup.

#### Scenario: Orphaned window detection
- **WHEN** a window is registered but crashes
- **WHEN** main process detects window is gone
- **THEN** system removes orphaned entry from registry
- **AND** does not block app shutdown

### Requirement: Multiple windows same worktree
The system SHALL handle the same worktree being open in multiple windows without conflict.

#### Scenario: Track multiple windows with same worktree
- **WHEN** worktree-1 is opened in windowId 1
- **AND** worktree-1 is opened in windowId 2
- **THEN** registry tracks both: [1, 2]
- **AND** closing window 1 does NOT remove window 2 from registry
