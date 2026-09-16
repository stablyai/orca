import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

/** Reconcile every workspace loaded during boot so stale unified-tab subsets converge. */
export function reconcileHydratedWorkspaceTabModels(
  session: Pick<WorkspaceSessionState, 'tabsByWorktree'>,
  // Why batched: one store write for the whole session instead of one per
  // workspace, each fanning out to every non-React store subscriber.
  reconcileWorktreeTabModels: (worktreeIds: readonly string[]) => void
): string[] {
  const reconciled = Object.keys(session.tabsByWorktree)
  if (reconciled.length > 0) {
    reconcileWorktreeTabModels(reconciled)
  }
  return reconciled
}
