import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isConversationReportOutcome, parseRemoteWorkerPayload } from './message-payload'

/** Refuses a send whose type and recipient can never be delivered, before any effect. */
export function assertSendParamsDeliverable(params: {
  type?: string
  to?: string
  payload?: string
}): void {
  if (params.type === 'worker_done') {
    const payload = parseRemoteWorkerPayload(params.payload)
    if (!isConversationReportOutcome(payload.outcome)) {
      throw new OrchestrationError(
        'invalid_argument',
        'worker_done requires outcome=succeeded|failed for a current Dispatch.'
      )
    }
    assertReportPathCaptured(payload)
  }
  if (params.to?.startsWith('task:')) {
    throw new OrchestrationError(
      'invalid_argument',
      'Task recipients are intentionally unsupported; use run:<id> or dispatch:<id>.'
    )
  }
}

export function assertReportPathCaptured(payload: Record<string, unknown>): void {
  if (typeof payload.reportPath === 'string' && typeof payload.reportContentBase64 !== 'string') {
    throw new OrchestrationError(
      'invalid_argument',
      'The report file bytes were missing. Submit --report-path from a current Orca CLI on the worker host.'
    )
  }
}
