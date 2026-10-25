// Match desktop’s synthetic id: Floating Workspace has no backing repo/worktree and always uses the local runtime.
export const FLOATING_WORKSPACE_WORKTREE_ID = 'global-floating-terminal'

export const FLOATING_WORKSPACE_TITLE = 'Floating Workspace'

export function isFloatingWorkspaceWorktreeId(worktreeId: string | null | undefined): boolean {
  return worktreeId === FLOATING_WORKSPACE_WORKTREE_ID
}

// Seed name in the route before session tabs load.
export function floatingWorkspaceSessionPath(hostId: string | undefined): string {
  return `/h/${hostId}/session/${FLOATING_WORKSPACE_WORKTREE_ID}?name=${encodeURIComponent(FLOATING_WORKSPACE_TITLE)}`
}
