import type { OrchestrationDb } from '../orchestration-db'
import type { WorkerDispatchRow } from '../orchestration-records'
import { isStructuredWorkerHandle } from '../../../../../shared/orchestration/workers/structured-worker-handle'
export const RETAINED_CHAT_BEFORE_BRIEF_STAGE = 'retained_chat_before_brief'

export function chatStartBeforeBrief(worker: WorkerDispatchRow): boolean {
  return worker.stage === RETAINED_CHAT_BEFORE_BRIEF_STAGE
}

/** Hold mail on older failed chat attachments too, since their delivery cannot be proven. */
export function failedWorkerChatAttachment(worker: WorkerDispatchRow): boolean {
  return (
    worker.state === 'failed' &&
    (chatStartBeforeBrief(worker) ||
      (worker.stage === 'authority_attached' &&
        isStructuredWorkerHandle(worker.agent_terminal_handle ?? '')))
  )
}

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
