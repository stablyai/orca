import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  nextWorkerPresence,
  readWorkerPresence,
  writeWorkerPresence
} from '../../db/worker-presence/worker-presence-store'
import { workerTurnStopDispatchId, type WorkerTurnStopDispatch } from './worker-turn-stop-report'

/** A turn began: its worker's rest, if any, is over, and a start left unknown is proven to have run. */
export function observeWorkerWorking(
  db: OrchestrationDb,
  target: WorkerTurnStopDispatch,
  /** A turn that began after the worker stopped, though nothing recorded the stop: a new fact. */
  newTurn: boolean
): void {
  const dispatchId = workerTurnStopDispatchId(target)
  const current = readWorkerPresence(db, dispatchId)
  const fence = newTurn ? `turn:${(current?.generation ?? 0) + 1}` : null
  const next = nextWorkerPresence(current, { presence: 'working', fence, report: null })
  if (next.changed) {
    writeWorkerPresence(db, dispatchId, next)
  }
  if (target.kind === 'local') {
    confirmUnknownWorkerStart(db, dispatchId)
  }
}

/** A turn seen begin proves a start left unknown ran: its worker is ready. */
export function confirmUnknownWorkerStart(db: OrchestrationDb, dispatchId: string): void {
  if (
    db.getWorkerDispatch(dispatchId)?.state !== 'start_unknown' ||
    db.getDispatchContextById(dispatchId)?.status !== 'pending'
  ) {
    return
  }
  try {
    db.markWorkerDispatchReady(dispatchId, undefined, 'start_unknown')
  } catch (error) {
    console.warn('[orchestration] confirming a worker start failed', dispatchId, error)
  }
}
