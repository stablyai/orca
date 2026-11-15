import type { RuntimeWorktreeTerminalSleepResult } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'

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
