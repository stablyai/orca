import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isConversationReportOutcome, parseRemoteWorkerPayload } from './message-payload'

/** Refuses a send whose type and recipient can never be delivered, before any effect. */
export function assertSendParamsDeliverable(params: {
  type?: string
  to?: string
  payload?: string
}): void {
  if (
    params.type === 'worker_done' &&
    !isConversationReportOutcome(parseRemoteWorkerPayload(params.payload).outcome)
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      'worker_done requires outcome=succeeded|failed for a current Dispatch.'
    )
  }
  if (params.to?.startsWith('task:')) {
    throw new OrchestrationError(
      'invalid_argument',
      'Task recipients are intentionally unsupported; use run:<id> or dispatch:<id>.'
    )
  }
}
