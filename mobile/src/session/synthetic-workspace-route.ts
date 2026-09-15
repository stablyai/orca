import { isFloatingWorkspaceWorktreeId } from './floating-workspace'
import { MOBILE_FOLDER_WORKSPACE_ROUTE_PREFIX } from './mobile-session-route-helpers'

/** Route ids that name no managed worktree, so the host can never list or resolve them.
 *  Every "is this workspace still there?" check must exempt them, or their permanent
 *  absence from the catalog reads as a deletion. */
export function isSyntheticWorkspaceRoute(worktreeId: string): boolean {
  return (
    worktreeId.startsWith(MOBILE_FOLDER_WORKSPACE_ROUTE_PREFIX) ||
    isFloatingWorkspaceWorktreeId(worktreeId)
  )
}
