/**
 * The WSL moves this process is running, one per distro; the journal's compare-and-swap orders a
 * run against other processes.
 */
import {
  isWslMoveCutoverFinished,
  wslMoveJournalKey
} from '../../../shared/wsl-move/wsl-move-cutover'
import { scanWslMoveCutovers } from './wsl-move-cutover-journal'

export type RunningWslMove = {
  controller: AbortController
  commitRequested: boolean
  /** The cutover this run journals; unset for a run that only settles an earlier one. */
  migrationId?: string
}

const runningMoves = new Map<string, RunningWslMove>()
// Undo runs by distro key; counted, as Restore may run beside a project's own undo.
const undoRuns = new Map<string, number>()

/** Null when a move of the distro already runs here, or the distro's move is being undone. */
export function claimWslMoveRun(distro: string): RunningWslMove | null {
  const key = wslMoveJournalKey(distro)
  // A run claimed mid-undo makes the undo refuse after it stopped the host's terminals.
  if (runningMoves.has(key) || undoRuns.has(key)) {
    return null
  }
  const running: RunningWslMove = { controller: new AbortController(), commitRequested: false }
  runningMoves.set(key, running)
  return running
}

/** Why `claimWslMoveRun` refused the distro just now: a move of it runs, or its move is being undone. */
export function wslMoveClaimRefusal(
  distro: string
): 'wsl_move_already_running' | 'wsl_move_undo_running' {
  return undoRuns.has(wslMoveJournalKey(distro))
    ? 'wsl_move_undo_running'
    : 'wsl_move_already_running'
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

/**
 * True while this process runs a move of the distro that has journaled its own cutover: from then
 * on the host holds the move's state, so its server must not be replaced under it. An earlier
 * move's record does not count, or settling it could never update an outdated server.
 */
export function isWslMoveUnderwayOnHost(userDataPath: string, distro: string): boolean {
  const migrationId = runningMoves.get(wslMoveJournalKey(distro))?.migrationId
  return (
    migrationId !== undefined &&
    scanWslMoveCutovers(userDataPath).some(
      (cutover) => cutover.migrationId === migrationId && !isWslMoveCutoverFinished(cutover)
    )
  )
}

/**
 * Marks "Use on this computer again" (or Restore) of the distro as running until the returned end
 * runs; no move or preview of the distro may claim a run meanwhile. Kept out of the move registry:
 * the quit prompt, Cancel and undo's own guards must not read an undo as a move.
 */
export function beginWslMoveUndoRun(distro: string): () => void {
  const key = wslMoveJournalKey(distro)
  undoRuns.set(key, (undoRuns.get(key) ?? 0) + 1)
  let ended = false
  return () => {
    if (ended) {
      return
    }
    ended = true
    const left = (undoRuns.get(key) ?? 1) - 1
    if (left > 0) {
      undoRuns.set(key, left)
    } else {
      undoRuns.delete(key)
    }
  }
}

/** True while this process brings a moved project of any distro back. */
export function isWslMoveUndoRunning(): boolean {
  return undoRuns.size > 0
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
