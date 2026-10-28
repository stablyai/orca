import type { RuntimeWorktreeTerminalSleepResult } from '../../../../shared/runtime-types'

/** A sleep that stopped nothing, leaving `livePtyIds` running. */
export function sleptNothing(
  livePtyIds: Iterable<string> = []
): RuntimeWorktreeTerminalSleepResult {
  return {
    stopped: 0,
    stoppedPtyIds: [],
    livePtyIds: [...livePtyIds].sort(),
    postStopVerified: true
  }
}
