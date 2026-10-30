import {
  MESSAGE_TYPES,
  type MessagePriority,
  type MessageType,
  type WorkerReportOutcome
} from './types'
import { OrchestrationError } from './orchestration-error'
import { parseFederatedWorkerReportPayload } from './federation-worker-report-payload'

export type RelayedMessage = {
  from: string
  subject: string
  body: string
  type: MessageType
  priority: MessagePriority
  threadId: string | null
  payload: string | null
}

const MESSAGE_TYPE_SET = new Set<MessageType>(MESSAGE_TYPES)

export function parseRelayedMessage(payload: string): RelayedMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw new OrchestrationError('invalid_argument', 'Federated relay payload is invalid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OrchestrationError('invalid_argument', 'Federated relay payload is not a message.')
  }
  const message = parsed as Partial<RelayedMessage>
  if (typeof message.subject !== 'string' || typeof message.body !== 'string') {
    throw new OrchestrationError('invalid_argument', 'Federated relay message is incomplete.')
  }
  if (typeof message.type !== 'string' || !MESSAGE_TYPE_SET.has(message.type as MessageType)) {
    throw new OrchestrationError(
      'invalid_argument',
      `Federated relay message type ${String(message.type)} is not supported.`
    )
  }
  return {
    from: typeof message.from === 'string' ? message.from : 'remote-worker',
    subject: message.subject,
    body: message.body,
    type: message.type as MessageType,
    priority:
      message.priority === 'high' || message.priority === 'urgent' ? message.priority : 'normal',
    threadId: typeof message.threadId === 'string' ? message.threadId : null,
    payload: typeof message.payload === 'string' ? message.payload : null
  }
}

export function parseFederatedLifecycle(
  message: RelayedMessage,
  messageId: string,
  dispatchId: string,
  taskId: string
):
  | { kind: 'none' }
  | { kind: 'heartbeat'; at: string }
  | { kind: 'worker_report'; taskId: string; outcome: WorkerReportOutcome; result: string }
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
  return {
    kind: 'worker_report',
    taskId: payload.taskId,
    outcome: payload.outcome,
    result: JSON.stringify({
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
  }
}
