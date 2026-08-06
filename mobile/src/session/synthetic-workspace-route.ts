import { isFloatingWorkspaceWorktreeId } from './floating-workspace'

/** Route ids that name no managed worktree, so the host can never list or resolve them.
 *  Every "is this workspace still there?" check must exempt them, or their permanent
 *  absence from the catalog reads as a deletion. */
export function isSyntheticWorkspaceRoute(worktreeId: string): boolean {
  return worktreeId.startsWith('folder:') || isFloatingWorkspaceWorktreeId(worktreeId)
}
