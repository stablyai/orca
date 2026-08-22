import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/**
 * Re-run tab-model reconciliation for every workspace the boot hydration just
 * loaded (#15710).
 *
 * Why: the unified tab model is hydrated verbatim from `session.unifiedTabs`,
 * but the same session's terminal rows can hold live PTYs that no canonical
 * entry claims — rows that re-attached on a host after its canonical model was
 * emptied (an update restart's PTY kill, a client writing a subset). The
 * per-workspace reconcile performs the same restoration the active-worktree
 * path runs, re-entering those rows into the unified model so a paired client's
 * tab bar reflects the host's real terminal set instead of a stale subset that
 * a later tab creation would rewrite.
 */
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
