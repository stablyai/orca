import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationError } from '../orchestration/orchestration-error'
import { formatMessageBanner } from '../orchestration/formatter'
import { ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS } from '../../../shared/orchestration-message-wait-timeout'
import type { LegacyCompatibilityAuthority } from './orchestration-legacy-authority'
import {
  operationIdentity,
  parseLegacyMailAck,
  parseLegacyQuestionAck,
  parseLegacyTypes,
  supportedLegacyHints,
  type LegacyCheckParams,
  type LegacyReplyParams
} from './orchestration-legacy-operation'

export async function handleLegacyCheck(args: {
  runtime: OrcaRuntimeService
  authority: LegacyCompatibilityAuthority
  request: RpcRequest
  params: LegacyCheckParams
  signal?: AbortSignal
}): Promise<unknown> {
  const { runtime, authority, request, params, signal } = args
  if (params.run) {
    return undefined
  }
  const typeFilter = parseLegacyTypes(params.types)
  const principal = authority.resolveCheckPrincipal(request, params.terminal)
  if (!principal) {
    return undefined
  }
  const db = runtime.getOrchestrationDb()
  if (params.compatibilityQuestionAck) {
    const answer = parseLegacyQuestionAck(params.compatibilityQuestionAck)
    const acknowledged = db.acknowledgeLegacyQuestionAnswer({
      principalId: principal.id,
      ...answer
    })
    return {
      messages: [],
      count: 0,
      acknowledged: [answer.answerMessageId],
      duplicate: acknowledged.duplicate,
      legacyCompatibility: { acknowledged: true }
    }
  }
  if (params.compatibilityAck) {
    const ack = parseLegacyMailAck(params.compatibilityAck)
    const acknowledged = db.acknowledgeLegacyMail({
      principalId: principal.id,
      messageIds: ack.messageIds,
      types: ack.types
    })
    return {
      messages: [],
      count: 0,
      acknowledged: ack.messageIds,
      duplicate: acknowledged.duplicate,
      legacyCompatibility: { acknowledged: true }
    }
  }

  const history = params.all || (params.unread === false && !params.peek)
  const readOnly = Boolean(params.peek || history)
  const read = () =>
    history
      ? db.getLegacyMailHistory({ principalId: principal.id, types: typeFilter })
      : db.getLegacyMailPage({ principalId: principal.id, types: typeFilter })
  let page = read()
  const deadline =
    Date.now() + Math.max(params.timeoutMs ?? ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS, 0)
  while (page.messages.length === 0 && params.wait && !signal?.aborted && Date.now() < deadline) {
    if (principal.role === 'coordinator' && db.hasPendingCurrentDelivery(principal.run_id)) {
      break
    }
    await runtime.waitForMessage(
      principal.role === 'worker'
        ? `dispatch:${principal.dispatch_id as string}`
        : principal.terminal_handle,
      {
        typeFilter,
        timeoutMs: Math.min(1_000, Math.max(deadline - Date.now(), 1)),
        signal
      }
    )
    page = read()
  }

  const consuming = !readOnly
  const messageIds = consuming ? page.messages.map((message) => message.id) : []
  const formattingAuthority = readOnly
    ? 'legacy_read_only'
    : page.recovery
      ? 'legacy_recovery_replay'
      : 'legacy_compatibility'
  const formatted =
    params.format || params.inject
      ? page.messages
          .map((message) =>
            formatMessageBanner(message, {
              authority: formattingAuthority,
              supportedActionHints: readOnly
                ? []
                : supportedLegacyHints(message, principal, params.compatibilityCliCommand ?? 'orca')
            })
          )
          .join('\n\n')
      : undefined
  const currentDelivery =
    principal.role === 'coordinator' && db.hasPendingCurrentDelivery(principal.run_id)
      ? {
          runId: principal.run_id,
          checkCommand: `${params.compatibilityCliCommand ?? 'orca'} orchestration check --run ${principal.run_id}`,
          ackCommand: `${params.compatibilityCliCommand ?? 'orca'} orchestration check --run ${principal.run_id} --ack <delivery-id>`
        }
      : undefined
  return {
    runId: principal.run_id,
    dispatchId: principal.dispatch_id,
    messages: page.messages,
    count: page.messages.length,
    formatted,
    timedOut: Boolean(params.wait && page.messages.length === 0 && !signal?.aborted),
    cancelled: signal?.aborted === true,
    connectionLost: signal?.aborted === true,
    legacyCompatibility: {
      recovery: page.recovery,
      readOnly,
      ackMessageIds: messageIds,
      currentDelivery
    }
  }
}

export async function handleLegacyReply(args: {
  runtime: OrcaRuntimeService
  authority: LegacyCompatibilityAuthority
  request: RpcRequest
  params: LegacyReplyParams
}): Promise<unknown> {
  const { runtime, authority, request, params } = args
  const db = runtime.getOrchestrationDb()
  const original = db.getMessageById(params.id)
  if (!original || original.delivery_contract !== 'legacy_direct') {
    return undefined
  }
  const principal = authority.attestCoordinator(request, original.run_id)
  if (!principal) {
    throw legacyCoordinatorReadOnly()
  }
  const operation = operationIdentity(request, 'reply', {
    questionId: params.id,
    body: params.body
  })
  const committed = db.commitLegacyReplyOperation({
    principalId: principal.id,
    operationKey: operation.key,
    method: request.method,
    payloadHash: operation.payloadHash,
    questionId: params.id,
    body: params.body
  })
  if (!committed.duplicate) {
    runtime.notifyMessageArrived(committed.question.asker_handle, 'status')
  }
  return {
    message: committed.message,
    question: committed.question,
    duplicate: committed.duplicate,
    legacyCompatibility: { replayed: committed.duplicate }
  }
}

function legacyCoordinatorReadOnly(): OrchestrationError {
  return new OrchestrationError(
    'legacy_read_only',
    'This retained legacy coordinator could not prove its original process identity. No effects were applied.',
    { effectsApplied: false }
  )
}
