import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { MessageType } from '../orchestration/db'
import { OrchestrationError } from '../orchestration/orchestration-error'
import type { LegacyCompatibilityAuthority } from './orchestration-legacy-authority'
import {
  inferLegacyWorkerOutcome,
  isWorkerOutcome,
  operationIdentity,
  parseLegacyPayload,
  stringValue,
  type LegacySendParams
} from './orchestration-legacy-operation'

export async function handleLegacyLifecycleSend(args: {
  runtime: OrcaRuntimeService
  authority: LegacyCompatibilityAuthority
  request: RpcRequest
  params: LegacySendParams
}): Promise<unknown | undefined> {
  const { runtime, authority, request, params } = args
  if (!['heartbeat', 'worker_done', 'escalation'].includes(params.type ?? '')) {
    return undefined
  }
  const payload = parseLegacyPayload(params.payload)
  const dispatch = authority.resolveWorkerDispatch(request, {
    terminalHandle: params.from,
    dispatchId: stringValue(payload.dispatchId),
    taskId: stringValue(payload.taskId)
  })
  if (!dispatch) {
    if (params.type === 'worker_done' && !isWorkerOutcome(payload.outcome)) {
      throw new OrchestrationError(
        'invalid_argument',
        'worker_done requires outcome=succeeded|failed for a current Dispatch.'
      )
    }
    return undefined
  }
  if (!params.to) {
    throw new OrchestrationError('invalid_argument', 'Legacy lifecycle mail requires --to.')
  }
  const db = runtime.getOrchestrationDb()
  if (!db.isLegacyCoordinatorHandle(dispatch.run_id, params.to)) {
    throw new OrchestrationError(
      'request_mismatch',
      `Terminal ${params.to} is not a retained coordinator for this legacy Dispatch.`
    )
  }

  if (
    params.type === 'worker_done' &&
    Object.hasOwn(payload, 'outcome') &&
    !isWorkerOutcome(payload.outcome)
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      'Legacy worker_done outcome must be succeeded or failed when provided.'
    )
  }
  const principal = authority.attestWorker(request, dispatch)
  const operation = operationIdentity(request, params.type as string, { ...params, payload })
  const inferredOutcome =
    params.type === 'worker_done'
      ? isWorkerOutcome(payload.outcome)
        ? payload.outcome
        : inferLegacyWorkerOutcome(params.subject)
      : undefined
  const existingId =
    params.type === 'worker_done'
      ? db.findLegacyWorkerCompletion({
          principalId: principal.id,
          taskId: dispatch.task_id,
          recipientHandle: params.to,
          subject: params.subject,
          body: params.body ?? '',
          payload: params.payload ?? null
        })?.id
      : undefined
  const committed = db.commitLegacyLifecycleOperation({
    principalId: principal.id,
    operationKey: operation.key,
    method: request.method,
    payloadHash: operation.payloadHash,
    message: {
      existingId,
      to: params.to,
      subject: params.subject,
      body: params.body,
      type: params.type as MessageType,
      priority: params.priority,
      payload: params.payload
    },
    lifecycle:
      params.type === 'heartbeat'
        ? { kind: 'heartbeat', at: new Date().toISOString() }
        : params.type === 'worker_done'
          ? {
              kind: 'worker_report',
              taskId: dispatch.task_id,
              outcome: inferredOutcome as 'succeeded' | 'failed',
              result: params.body || params.subject
            }
          : { kind: 'message_only' }
  })
  if (!committed.duplicate) {
    runtime.notifyMessageArrived(committed.message.to_handle, committed.message.type)
  }
  return {
    message: committed.message,
    ...(committed.settlement ? { lifecycle: committed.settlement } : {}),
    legacyCompatibility: { replayed: committed.duplicate }
  }
}
