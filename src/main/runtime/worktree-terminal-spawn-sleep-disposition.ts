import { runtimeWorktreeIdentityKey } from './runtime-worktree-path-identity'

export type WorktreeSpawnSleepDisposition = 'wake' | 'leave'

export type WorktreeTerminalSleepPhase = 'stopping' | 'partial' | 'sleeping'

export type WorktreeTerminalSleepSnapshot = {
  worktreeId: string
  generation: number
  phase: WorktreeTerminalSleepPhase
  ptyIds: string[]
  terminalHandles: string[]
  terminalHandlesByPtyId: Record<string, string[]>
}

export class WorktreeTerminalLeftAsleepError extends Error {
  constructor() {
    super('worktree_terminal_left_asleep')
    this.name = 'WorktreeTerminalLeftAsleepError'
  }
}

export function isWorktreeTerminalLeftAsleep(error: unknown): boolean {
  return error instanceof WorktreeTerminalLeftAsleepError
}

/** Host sleep, including an in-progress stop, is not a dropped connection. */
export function hostWorktreeSleepBlocksAutomaticRecovery(
  phase: WorktreeTerminalSleepPhase | undefined
): boolean {
  return phase === 'stopping' || phase === 'sleeping' || phase === 'partial'
}

/**
 * Returns true when the spawn lock must be released without creating a PTY.
 * A user spawn still clears a committed sleep. An automatic recovery must not.
 */
export function settleWorktreeSpawnSleep(
  sleepStates: Map<string, WorktreeTerminalSleepSnapshot>,
  worktreeId: string,
  disposition: WorktreeSpawnSleepDisposition,
  emitClientEvent: (event: {
    type: 'worktreeTerminalSleepState'
    worktreeId: string
    generation: number
    phase: 'woken'
    ptyIds: string[]
    terminalHandles: string[]
  }) => void
): boolean {
  const key = runtimeWorktreeIdentityKey(worktreeId)
  const sleepState = sleepStates.get(key)
  // `stopping` stays inside the exclusive mutation lock and is replaced by
  // sleeping, partial, or deletion before that lock is released.
  if (sleepState?.phase !== 'sleeping' && sleepState?.phase !== 'partial') {
    return false
  }
  if (disposition === 'leave') {
    return true
  }
  sleepStates.delete(key)
  emitClientEvent({
    type: 'worktreeTerminalSleepState',
    worktreeId: sleepState.worktreeId,
    generation: sleepState.generation,
    phase: 'woken',
    ptyIds: sleepState.ptyIds,
    terminalHandles: sleepState.terminalHandles
  })
  return false
}
