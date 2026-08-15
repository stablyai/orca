import type { MessageType, WorkerReportOutcome } from './types'
import { parseFederatedWorkerReportPayload } from './federation-worker-report-payload'

type FederatedLifecycleMessage = {
  subject: string
  body: string
  type: MessageType
  payload: string | null
}

export function parseFederatedLifecycle(
  message: FederatedLifecycleMessage,
  relayKind: string,
  messageId: string,
  dispatchId: string,
  taskId: string
):
  | { kind: 'none' }
  | { kind: 'heartbeat'; at: string }
  | {
      kind: 'worker_report'
      taskId: string
      outcome: WorkerReportOutcome
      result: string
    }
  | {
      kind: 'runtime_failure'
      taskId: string
      reason: string
      result: string
    }
  | { kind: 'rejected'; code: string; reason: string } {
  if (message.type === 'heartbeat') {
    return { kind: 'heartbeat', at: new Date().toISOString() }
  }
  if (message.type !== 'worker_done') {
    return { kind: 'none' }
  }
  let payload
  try {
    payload = parseFederatedWorkerReportPayload(message.payload)
  } catch (error) {
    return {
      kind: 'rejected',
      code: 'invalid_payload',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
  if (payload.dispatchId !== dispatchId || payload.taskId !== taskId) {
    return {
      kind: 'rejected',
      code: 'task_dispatch_mismatch',
      reason: `Federated report does not match Dispatch ${dispatchId}.`
    }
  }
  const result = JSON.stringify({
    provenance: 'worker_report',
    outcome: payload.outcome,
    messageId,
    reportedBy: `dispatch:${dispatchId}`,
    subject: message.subject,
    body: message.body,
    completedBy: `dispatch:${dispatchId}`,
    filesModified: payload.filesModified,
    reportPath: payload.reportPath,
    completedAt: new Date().toISOString()
  })
  if (relayKind === 'runtime_failure' && payload.runtimeFailure) {
    return {
      kind: 'runtime_failure',
      taskId: payload.taskId,
      reason: payload.runtimeFailure,
      result
    }
  }
  return {
    kind: 'worker_report',
    taskId: payload.taskId,
    outcome: payload.outcome,
    result
  }
}
