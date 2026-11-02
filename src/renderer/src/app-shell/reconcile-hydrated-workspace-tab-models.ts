import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { showStartupLayoutFrames } from '../runtime/workspace-layout-frame-sync'
import { followSleepingRecordsInLayoutOwner } from '../runtime/sleeping-records-to-layout-owner'

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
  // Switch point: from main's first layout snapshot on, the frames' workspaces replace what restore
  // built for them. Records frames do not carry (sleeping agents, closed tabs, default-tab marks,
  // what reattaches) and the view stay restore's; main records later resume-record changes itself.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    showStartupLayoutFrames()
    followSleepingRecordsInLayoutOwner()
  }
  return reconciled
}
