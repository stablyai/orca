import {
  MESSAGE_TYPES,
  type MessagePriority,
  type MessageType,
  type WorkerReportOutcome
} from './types'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationError } from './orchestration-error'

const MESSAGE_TYPE_SET = new Set<MessageType>(MESSAGE_TYPES)

function isMessageType(value: unknown): value is MessageType {
  return typeof value === 'string' && MESSAGE_TYPE_SET.has(value as MessageType)
}

type PulledRelayItem = {
  dispatch_id: string
  direction: 'to_home'
  sequence: number
  message_id: string
  kind: string
  payload: string
}

type RelayedMessage = {
  from: string
  subject: string
  body: string
  type: MessageType
  priority: MessagePriority
  threadId: string | null
  payload: string | null
}

export async function syncFederatedDispatch(
  runtime: OrcaRuntimeService,
  dispatchId: string
): Promise<{ imported: number; acknowledgedThrough: number }> {
  const db = runtime.getOrchestrationDb()
  const federated = db.getFederatedDispatch(dispatchId)
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!federated || !dispatch) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Federated Dispatch ${dispatchId} was not found.`
    )
  }
  const currentServer = runtime.resolveOrchestrationWorkerServer(federated.environment_id)
  if (currentServer.peerFingerprint !== federated.peer_fingerprint) {
    throw new OrchestrationError(
      'peer_changed',
      `Saved environment ${federated.environment_name} now identifies a different Orca server.`
    )
  }

  const pulled = (await runtime.callOrchestrationWorkerServer(
    federated.environment_id,
    'orchestration.federationPull',
    {
      dispatchId,
      afterSequence: federated.to_home_imported_sequence,
      limit: 50
    },
    15_000
  )) as { runtimeEpoch: string; items: PulledRelayItem[] }
  let cursor = federated.to_home_imported_sequence
  let imported = 0
  for (const item of pulled.items) {
    if (item.dispatch_id !== dispatchId || item.sequence !== cursor + 1) {
      throw new OrchestrationError(
        'operation_unknown',
        `Federated relay for ${dispatchId} is not contiguous after sequence ${cursor}.`
      )
    }
    const message = parseRelayedMessage(item.payload)
    const stored = db.importFederatedRelayItem({
      dispatchId,
      sequence: item.sequence,
      message: {
        id: item.message_id,
        runId: dispatch.run_id,
        from: `dispatch:${dispatchId}`,
        to: `run:${dispatch.run_id}`,
        subject: message.subject,
        body: message.body,
        type: message.type,
        priority: message.priority,
        threadId: message.threadId ?? undefined,
        payload: message.payload ?? undefined
      },
      lifecycle: parseFederatedLifecycle(message, item.message_id, dispatchId, dispatch.task_id)
    })
    cursor = item.sequence
    runtime.notifyMessageArrived(stored.message.to_handle, stored.message.type)
    imported += stored.duplicate ? 0 : 1
  }

  if (cursor > 0) {
    await runtime.callOrchestrationWorkerServer(
      federated.environment_id,
      'orchestration.federationAck',
      { dispatchId, throughSequence: cursor },
      15_000,
      { orchestrationRequestId: `relay_ack_${dispatchId}_${cursor}` }
    )
  }
  const toWorker =
    db.getWorkerDispatch(dispatchId)?.state === 'ready'
      ? db.listPendingFederationRelay(dispatchId, 'to_worker')
      : []
  if (toWorker.length > 0) {
    const delivered = (await runtime.callOrchestrationWorkerServer(
      federated.environment_id,
      'orchestration.federationImport',
      { dispatchId, items: toWorker },
      15_000,
      {
        orchestrationRequestId: `relay_import_${dispatchId}_${toWorker.at(-1)?.sequence ?? 0}`
      }
    )) as { acknowledgedThrough: number }
    db.acknowledgeFederationRelay({
      dispatchId,
      direction: 'to_worker',
      throughSequence: delivered.acknowledgedThrough
    })
  }
  return { imported, acknowledgedThrough: cursor }
}

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
  if (!isMessageType(message.type)) {
    throw new OrchestrationError(
      'invalid_argument',
      `Federated relay message type ${String(message.type)} is not supported.`
    )
  }
  return {
    from: typeof message.from === 'string' ? message.from : 'remote-worker',
    subject: message.subject,
    body: message.body,
    type: message.type,
    priority:
      message.priority === 'high' || message.priority === 'urgent' ? message.priority : 'normal',
    threadId: typeof message.threadId === 'string' ? message.threadId : null,
    payload: typeof message.payload === 'string' ? message.payload : null
  }
}

function parseFederatedLifecycle(
  message: RelayedMessage,
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
  | { kind: 'rejected'; code: string; reason: string } {
  if (message.type === 'heartbeat') {
    return { kind: 'heartbeat', at: new Date().toISOString() }
  }
  if (message.type !== 'worker_done') {
    return { kind: 'none' }
  }
  let payload
  try {
    payload = parseWorkerReportPayload(message.payload)
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
  return {
    kind: 'worker_report',
    taskId: payload.taskId,
    outcome: payload.outcome,
    result
  }
}

function parseWorkerReportPayload(payload: string | null): {
  taskId: string
  dispatchId: string
  outcome: WorkerReportOutcome
  filesModified: string[]
  reportPath: string | null
} {
  let parsed: unknown
  try {
    parsed = payload ? JSON.parse(payload) : null
  } catch {
    parsed = null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OrchestrationError('invalid_argument', 'Federated worker report is invalid.')
  }
  const report = parsed as Record<string, unknown>
  if (
    typeof report.taskId !== 'string' ||
    typeof report.dispatchId !== 'string' ||
    (report.outcome !== 'succeeded' && report.outcome !== 'failed')
  ) {
    throw new OrchestrationError('invalid_argument', 'Federated worker report is incomplete.')
  }
  return {
    taskId: report.taskId,
    dispatchId: report.dispatchId,
    outcome: report.outcome,
    filesModified: Array.isArray(report.filesModified)
      ? report.filesModified.filter((file): file is string => typeof file === 'string')
      : [],
    reportPath: typeof report.reportPath === 'string' ? report.reportPath : null
  }
}
