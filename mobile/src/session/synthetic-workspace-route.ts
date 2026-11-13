import { isFloatingWorkspaceWorktreeId } from './floating-workspace'

// Exempt synthetic ids from missing-workspace checks: no managed host catalog can ever list them.
export function isSyntheticWorkspaceRoute(worktreeId: string): boolean {
  return worktreeId.startsWith('folder:') || isFloatingWorkspaceWorktreeId(worktreeId)
}
