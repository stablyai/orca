import {
  MESSAGE_TYPES,
  type MessagePriority,
  type MessageType,
  type WorkerReportOutcome
} from './types'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { FederatedLifecycleSettlement } from './federation-lifecycle-settlement'
import { ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION } from '../../../shared/protocol-version'
import { OrchestrationError } from './orchestration-error'
import {
  acquireFederationAckLease,
  getFederationAckedThrough,
  recordFederationAckCheckpoint
} from './federation-ack-checkpoints'
import { parseFederatedWorkerReportPayload } from './federation-worker-report-payload'

const MESSAGE_TYPE_SET = new Set<MessageType>(MESSAGE_TYPES)
const FEDERATION_PULL_PAGE_SIZE = 50
const MAX_FEDERATION_PULL_PAGES_PER_SYNC = 6

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
  return syncFederatedDispatchPages(runtime, dispatchId, MAX_FEDERATION_PULL_PAGES_PER_SYNC)
}

async function syncFederatedDispatchPages(
  runtime: OrcaRuntimeService,
  dispatchId: string,
  remainingPages: number
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
  const ackLease = acquireFederationAckLease(runtime, dispatchId)
  const supportsLifecycleSettlement =
    federated.protocol_version >= ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION

  const pulled = (await runtime.callOrchestrationWorkerServer(
    federated.environment_id,
    'orchestration.federationPull',
    {
      dispatchId,
      afterSequence: federated.to_home_imported_sequence,
      ...(supportsLifecycleSettlement ? { replayUnacknowledged: true } : {}),
      limit: FEDERATION_PULL_PAGE_SIZE
    },
    15_000
  )) as { runtimeEpoch: string; items: PulledRelayItem[] }
  let cursor =
    supportsLifecycleSettlement && pulled.items.length > 0
      ? pulled.items[0].sequence - 1
      : federated.to_home_imported_sequence
  let imported = 0
  const settlements: { sequence: number; lifecycle: FederatedLifecycleSettlement }[] = []
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
    if (stored.lifecycle && supportsLifecycleSettlement) {
      settlements.push({
        sequence: item.sequence,
        lifecycle:
          stored.lifecycle.action === 'settled'
            ? {
                action: stored.lifecycle.outcome === 'succeeded' ? 'completed' : 'failed',
                authority: 'run_home'
              }
            : { ...stored.lifecycle, authority: 'run_home' }
      })
    }
    cursor = item.sequence
    runtime.notifyMessageArrived(stored.message.to_handle, stored.message.type)
    imported += stored.duplicate ? 0 : 1
  }

  const ackIdentity = {
    environmentId: federated.environment_id,
    peerFingerprint: federated.peer_fingerprint,
    remoteRuntimeEpoch: pulled.runtimeEpoch
  }
  const durableAcknowledgedThrough =
    federated.remote_runtime_epoch === pulled.runtimeEpoch
      ? (federated.to_home_acknowledged_sequence ?? 0)
      : 0
  if (
    cursor > Math.max(getFederationAckedThrough(ackLease, ackIdentity), durableAcknowledgedThrough)
  ) {
    const delivered = (await runtime.callOrchestrationWorkerServer(
      federated.environment_id,
      'orchestration.federationAck',
      {
        dispatchId,
        throughSequence: cursor,
        ...(settlements.length > 0 ? { settlements } : {})
      },
      15_000,
      { orchestrationRequestId: `relay_ack_${dispatchId}_${cursor}` }
    )) as { acknowledgedThrough: number }
    const keepRelayEligible =
      pulled.items.length === FEDERATION_PULL_PAGE_SIZE && remainingPages === 1
    const locallyAcknowledgedThrough = keepRelayEligible
      ? Math.max(0, delivered.acknowledgedThrough - 1)
      : delivered.acknowledgedThrough
    db.recordFederatedHomeAcknowledgment({
      dispatchId,
      remoteRuntimeEpoch: pulled.runtimeEpoch,
      sequence: locallyAcknowledgedThrough
    })
    recordFederationAckCheckpoint(runtime, ackLease, {
      ...ackIdentity,
      throughSequence: locallyAcknowledgedThrough
    })
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
  if (pulled.items.length === FEDERATION_PULL_PAGE_SIZE && remainingPages > 1) {
    const next = await syncFederatedDispatchPages(runtime, dispatchId, remainingPages - 1)
    return {
      imported: imported + next.imported,
      acknowledgedThrough: next.acknowledgedThrough
    }
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
  return {
    kind: 'worker_report',
    taskId: payload.taskId,
    outcome: payload.outcome,
    result
  }
}
