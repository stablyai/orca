// Mirrors FLOATING_TERMINAL_WORKTREE_ID in src/shared/constants.ts — the desktop
// Floating Workspace's synthetic id (no backing repo/worktree; always local runtime).
export const FLOATING_WORKSPACE_WORKTREE_ID = 'global-floating-terminal'

export const FLOATING_WORKSPACE_TITLE = 'Floating Workspace'

export function isFloatingWorkspaceWorktreeId(worktreeId: string | null | undefined): boolean {
  return worktreeId === FLOATING_WORKSPACE_WORKTREE_ID
}

// Route target for the host-header entry; the ?name param seeds the session
// screen title before tabs load.
export function floatingWorkspaceSessionPath(hostId: string | undefined): string {
  return `/h/${hostId}/session/${FLOATING_WORKSPACE_WORKTREE_ID}?name=${encodeURIComponent(FLOATING_WORKSPACE_TITLE)}`
}
