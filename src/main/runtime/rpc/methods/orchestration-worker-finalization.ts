import { OrchestrationOperationOutcomeUnknownError } from '../../../../shared/orchestration-agent-prompt-outcome'
import type { OrchestrationDb } from '../../orchestration/db'

export function finalizeWorkerDispatch(
  db: OrchestrationDb,
  dispatchId: string,
  effects: unknown[]
) {
  try {
    return db.markWorkerDispatchReady(dispatchId, effects)
  } catch (error) {
    throw new OrchestrationOperationOutcomeUnknownError('Worker dispatch finalization', error)
  }
}

export function finalizeRemoteWorkerAttachment(
  db: OrchestrationDb,
  dispatchId: string,
  effects: unknown[]
) {
  try {
    return db.markRemoteAttachmentReady(dispatchId, effects)
  } catch (error) {
    throw new OrchestrationOperationOutcomeUnknownError('Federated worker finalization', error)
  }
}
