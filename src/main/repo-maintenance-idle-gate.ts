import { availableParallelism, loadavg } from 'node:os'
import { app, powerMonitor } from 'electron'
import {
  disposeLocalRepoMaintenance,
  postponeRepoMaintenance,
  setRepoMaintenanceActivityProbe
} from './git/local-repo-maintenance'
import { hasWorktreeRemovalsInFlight } from './ipc/worktrees/worktree-ipc-context'
import { hasPendingWorktreeCreatePreparations } from './worktree-create-preparation'

/**
 * The app-wide activity answer for idle repo maintenance, in two parts.
 *
 * `interactive` is what ref maintenance must wait for. `pack-refs` holds a
 * general git admission slot for its whole run, which on a large backlog is
 * minutes, and takes the `packed-refs` lock while it writes. Any ref deletion
 * needs that same lock and gives up after `core.packedRefsTimeout` (1s), so a
 * worktree removal, a create in flight and an agent mid-run all hold it off.
 *
 * `constrained` is what every task must wait for: shutdown, battery -- this is
 * work the user did not ask for, and a plugged-in window always comes along
 * later -- and a CPU already saturated.
 */
export type RepoMaintenanceIdleInputs = {
  isQuitting: () => boolean
  getWorkingAgentCount: () => number
}

export function installRepoMaintenanceIdleGate(
  inputs: RepoMaintenanceIdleInputs
): () => Promise<void> {
  setRepoMaintenanceActivityProbe(() => ({
    interactive:
      inputs.getWorkingAgentCount() > 0 ||
      hasPendingWorktreeCreatePreparations() ||
      hasWorktreeRemovalsInFlight(),
    constrained: inputs.isQuitting() || isOnBatteryPower() || isHostSaturated()
  }))
  // Do-not-start, never stop-what-is-running. Killing a pack to honour focus
  // would strand a ref lock roughly one time in five to save at most a couple of
  // minutes of background unlinking.
  const onFocus = (): void => {
    postponeRepoMaintenance()
  }
  app.on('browser-window-focus', onFocus)
  return () => {
    app.off('browser-window-focus', onFocus)
    // Order matters: clearing the probe alone would leave armed timers running
    // against a gate that can no longer see agents, creates, or shutdown.
    const stopped = disposeLocalRepoMaintenance()
    setRepoMaintenanceActivityProbe(null)
    return stopped
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

/** One-minute load at or above one runnable task per core. Always false on Windows, which reports no load. */
function isHostSaturated(): boolean {
  return loadavg()[0] / Math.max(1, availableParallelism()) >= 1
}
