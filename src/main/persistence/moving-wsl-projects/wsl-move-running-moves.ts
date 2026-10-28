/**
 * The WSL moves this process is running, one per distro; the journal's compare-and-swap orders a
 * run against other processes.
 */
import { wslMoveJournalKey } from '../../../shared/wsl-move/wsl-move-cutover'

export type RunningWslMove = { controller: AbortController; commitRequested: boolean }

const runningMoves = new Map<string, RunningWslMove>()

/** Null when a move of the distro already runs here. */
export function claimWslMoveRun(distro: string): RunningWslMove | null {
  const key = wslMoveJournalKey(distro)
  if (runningMoves.has(key)) {
    return null
  }
  const running: RunningWslMove = { controller: new AbortController(), commitRequested: false }
  runningMoves.set(key, running)
  return running
}

export function releaseWslMoveRun(distro: string, running: RunningWslMove): void {
  const key = wslMoveJournalKey(distro)
  if (runningMoves.get(key) === running) {
    runningMoves.delete(key)
  }
}

/** True while this process runs a move of the distro, through its desktop rewrite. */
export function isWslMoveRunning(distro: string): boolean {
  return runningMoves.has(wslMoveJournalKey(distro))
}

/** True while this process runs a move of any distro. */
export function isAnyWslMoveRunning(): boolean {
  return runningMoves.size > 0
}

/** Cancels a run that has not asked the host to commit yet; true when one was running. */
export function cancelWslMove(distro: string): boolean {
  const running = runningMoves.get(wslMoveJournalKey(distro))
  if (!running || running.commitRequested) {
    return false
  }
  running.controller.abort()
  return true
}
