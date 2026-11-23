// The Git worktree selector a terminal launch target resolves, decided before it resolves anything.
import { isFloatingWorkspaceSelector } from '../../../../shared/workspace/identity/floating-workspace-worktree'
import { parseWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'

/** The selector the launch target hands to the Git worktree lookup, or null when it resolves without one
 *  (a folder key or the floating workspace). A bare `id:<repo>::<path>` is passed on as it is. */
export function launchTargetGitSelector(selector: string): string | null {
  if (isFloatingWorkspaceSelector(selector)) {
    return null
  }
  const scope = parseWorkspaceKey(selector.startsWith('id:') ? selector.slice(3) : selector)
  if (scope?.type === 'folder') {
    return null
  }
  return scope?.type === 'worktree' ? `id:${scope.worktreeId}` : selector
}
