import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

/** Reconcile every workspace loaded during boot so stale unified-tab subsets converge. */
export function reconcileHydratedWorkspaceTabModels(
  session: Pick<WorkspaceSessionState, 'tabsByWorktree' | 'unifiedTabs'>,
  // Why batched: one store write for the whole session instead of one per
  // workspace, each fanning out to every non-React store subscriber.
  reconcileWorktreeTabModels: (worktreeIds: readonly string[]) => void
): string[] {
  // Why unifiedTabs too: an editor-only workspace has no terminal rows, and skipping it
  // let tabs with no OpenFile render and re-persist on every restart (#21121).
  const reconciled = [
    ...new Set([...Object.keys(session.tabsByWorktree), ...Object.keys(session.unifiedTabs ?? {})])
  ]
  if (reconciled.length > 0) {
    reconcileWorktreeTabModels(reconciled)
  }
  return reconciled
}
