import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

/** Reconcile every workspace loaded during boot so stale unified-tab subsets converge. */
export function reconcileHydratedWorkspaceTabModels(
  session: Pick<WorkspaceSessionState, 'tabsByWorktree'>,
  reconcileWorktreeTabModel: (worktreeId: string) => unknown
): string[] {
  const reconciled: string[] = []
  for (const worktreeId of Object.keys(session.tabsByWorktree)) {
    reconcileWorktreeTabModel(worktreeId)
    reconciled.push(worktreeId)
  }
  return reconciled
}
