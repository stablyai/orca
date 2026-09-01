import { powerMonitor } from 'electron'
import {
  disposeLocalRepoRefMaintenance,
  setRepoMaintenanceActivityProbe
} from './git/local-repo-ref-maintenance'
import { hasWorktreeRemovalsInFlight } from './ipc/worktrees/worktree-ipc-context'
import { hasPendingWorktreeCreatePreparations } from './worktree-create-preparation'

/**
 * The app-wide "not now" answer for idle repo maintenance.
 *
 * `pack-refs` holds a general git admission slot for its whole run, which on a
 * large backlog is minutes, and takes the `packed-refs` lock while it writes.
 * Any ref deletion needs that same lock and gives up after
 * `core.packedRefsTimeout` (1s), so worktree removal in particular has to veto
 * this -- as does a create in flight, an agent mid-run, and shutdown. Battery is
 * a veto too: this is work the user did not ask for, and a plugged-in quiet
 * window always comes along later.
 */
export type RepoMaintenanceIdleInputs = {
  isQuitting: () => boolean
  getWorkingAgentCount: () => number
}

export function installRepoMaintenanceIdleGate(inputs: RepoMaintenanceIdleInputs): () => void {
  setRepoMaintenanceActivityProbe(
    () =>
      inputs.isQuitting() ||
      inputs.getWorkingAgentCount() > 0 ||
      hasPendingWorktreeCreatePreparations() ||
      hasWorktreeRemovalsInFlight() ||
      isOnBatteryPower()
  )
  return () => {
    // Order matters: clearing the probe alone would leave armed timers running
    // against a gate that can no longer see agents, creates, or shutdown.
    disposeLocalRepoRefMaintenance()
    setRepoMaintenanceActivityProbe(null)
  }
}

function isOnBatteryPower(): boolean {
  try {
    return powerMonitor.isOnBatteryPower()
  } catch {
    // Absence of the API is not evidence of battery; desktops answer false anyway.
    return false
  }
}
