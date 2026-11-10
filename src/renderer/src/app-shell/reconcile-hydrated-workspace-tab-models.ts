import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { showStartupLayoutFrames } from '../runtime/workspace-layout/frames/workspace-layout-frame-sync'
import { showServerLayoutFrames } from '../runtime/workspace-layout/server/server-layout-frames'
import { followSleepingRecordsInLayoutOwner } from '../runtime/workspace-layout/sleep-records/sleeping-records-to-layout-owner'

/** Reconcile every workspace loaded during boot so stale unified-tab subsets converge. */
export function reconcileHydratedWorkspaceTabModels(
  session: Pick<WorkspaceSessionState, 'tabsByWorktree'>,
  // Batch all workspaces into one write to avoid repeated non-React subscriber fanout.
  reconcileWorktreeTabModels: (worktreeIds: readonly string[]) => void
): string[] {
  const reconciled = Object.keys(session.tabsByWorktree)
  if (reconciled.length > 0) {
    reconcileWorktreeTabModels(reconciled)
  }
  // After initial frames, each main/server stream owns its workspaces’ layout. Restore retains view and frame-absent records: sleeping agents, closed tabs, default-tab marks and reconnect plans; main tracks later resume changes.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    showStartupLayoutFrames()
    showServerLayoutFrames()
    followSleepingRecordsInLayoutOwner()
  }
  return reconciled
}
