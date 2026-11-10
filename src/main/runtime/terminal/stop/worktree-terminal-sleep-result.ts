import { teardownRpcDeadline } from '../../workspaces/removal/worktree-teardown-deadline'
import type { RuntimeWorktreeTerminalSleepResult } from '../../../../shared/runtime-terminal-contracts'

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

export function classifyTerminalSleepStops(
  orderedLivePtyIds: readonly string[],
  stopResults: readonly PromiseSettledResult<{ ptyId: string; stopped: boolean }>[]
): { successfulStopPtyIds: string[]; failedStopIndex: number } {
  const successfulStopPtyIds = orderedLivePtyIds.filter((_, index) => {
    const result = stopResults[index]
    return result?.status === 'fulfilled' && result.value.stopped
  })
  const failedStopIndex = stopResults.findIndex((result) =>
    result.status === 'rejected' ? true : !result.value.stopped
  )
  return { successfulStopPtyIds, failedStopIndex }
}

export function terminalSleepStopFailure(
  worktreeId: string,
  ptyId: string,
  result: PromiseSettledResult<{ ptyId: string; stopped: boolean }>,
  remainingLivePtyIds?: readonly string[]
): Error {
  const cause = result.status === 'rejected' ? result.reason : 'stop_not_acknowledged'
  if (remainingLivePtyIds) {
    console.error('[runtime] worktree terminal sleep physical stop failed', {
      worktreeId,
      ptyId,
      cause
    })
  }
  return Object.assign(new Error('terminal_worktree_sleep_failed'), {
    ptyId,
    ...(remainingLivePtyIds ? { remainingLivePtyIds: [...remainingLivePtyIds].sort() } : {}),
    ...(result.status === 'rejected' ? { cause: result.reason } : {})
  })
}

export function stopSleepingTerminals(
  ids: readonly string[],
  stop: (id: string, options: { keepHistory: boolean; deadlineMs: number }) => Promise<boolean>,
  deadline: number,
  settled: (id: string, stopped: boolean) => void
): Promise<PromiseSettledResult<{ ptyId: string; stopped: boolean }>[]> {
  return Promise.allSettled(
    ids.map(async (ptyId) => {
      const stopped = await stop(ptyId, {
        keepHistory: true,
        deadlineMs: teardownRpcDeadline(deadline)
      })
      settled(ptyId, stopped)
      return { ptyId, stopped }
    })
  )
}

export function markSleepingTerminalStops(
  settlements: Map<string, (stopped: boolean) => void>,
  ids: readonly string[],
  mark: (id: string) => (stopped: boolean) => void
): void {
  for (const id of ids) {
    settlements.set(id, mark(id))
  }
}

export function unverifiedSleepResult(
  stoppedPtyIds: string[],
  live: Iterable<string>,
  remaining?: Iterable<string>
): RuntimeWorktreeTerminalSleepResult {
  return {
    stopped: stoppedPtyIds.length,
    stoppedPtyIds,
    livePtyIds: [...live].sort(),
    postStopVerified: false,
    ...(remaining
      ? {
          postStopFailure: 'terminal_worktree_sleep_still_live' as const,
          remainingLivePtyIds: [...remaining].sort()
        }
      : { postStopFailure: 'terminal_liveness_unavailable' as const })
  }
}
