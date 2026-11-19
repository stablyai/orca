import { mainProcessState as state } from '../main-process-state'
import type { QuitStopTarget } from '../../runtime/terminal/stop/quit-idle-agent-stops'

// Each idle agent's history checkpoint and stop; one that misses it keeps running, as before.
const IDLE_AGENT_QUIT_STOP_DEADLINE_MS = 4_000

/** Pick idle agents while hook rows and remote viewers still exist; quit teardown clears them.
 *  Update installs keep every session for warm reattach; serve panes belong to paired clients. */
export function selectIdleAgentQuitStops(updateQuitInProgress: boolean): QuitStopTarget[] {
  if (updateQuitInProgress || state.isServeMode) {
    return []
  }
  try {
    return state.runtime?.selectIdleAgentTerminalsForQuit() ?? []
  } catch (error) {
    console.warn('[quit] Failed to pick idle agents to stop:', error)
    return []
  }
}

/** Stop the picked agents only once the final save is durable, so next launch resumes them as
 *  after a reboot; a failed save leaves them running. */
export async function stopIdleAgentsAfterFinalSave(
  targets: readonly QuitStopTarget[],
  finalSaveDurable: Promise<boolean>
): Promise<void> {
  if (targets.length === 0 || !(await finalSaveDurable)) {
    return
  }
  await state.runtime
    ?.stopIdleAgentTerminalsForQuit(targets, Date.now() + IDLE_AGENT_QUIT_STOP_DEADLINE_MS)
    .catch((error) => console.warn('[quit] Failed to stop idle agents:', error))
}
