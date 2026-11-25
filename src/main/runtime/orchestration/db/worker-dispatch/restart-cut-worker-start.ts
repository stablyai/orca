import type { OrchestrationDb } from '../orchestration-db'
import type { WorkerDispatchRow } from '../orchestration-records'

/** A start begun by an earlier runtime never reaches its receipt: it is settled as unknown, so every
 *  reader (show, stop, the restart pass) sees the same state. */
export function settleRestartCutWorkerStart(
  db: OrchestrationDb,
  dispatchId: string,
  runtimeId: string
): WorkerDispatchRow | undefined {
  const worker = db.getWorkerDispatch(dispatchId)
  if (worker?.state !== 'starting' || worker.runtime_epoch === runtimeId) {
    return worker
  }
  return db.markWorkerStartUnknown(
    dispatchId,
    worker.stage,
    'The runtime restarted before worker-start reached a terminal receipt.'
  )
}
