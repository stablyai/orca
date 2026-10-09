import {
  admitAgentSessionMutation,
  computeAgentSessionPayloadFingerprint
} from '../../../shared/agent-session-mutation-envelope'
import { commandReceiptScope } from '../agent-session-journal/command-receipt-schema'
import type { AgentSessionMutationRequest } from './structured-agent-session-mutation-admission'
import type { MutationPlan } from './structured-agent-session-mutation-plans'

/** Whether admission would run `plan` for the first time now, placing nothing: for an effect that
 *  must not wait in the session's queue for its turn. An id its receipt already answers never
 *  does, nor one whose receipt cannot be read. */
export function agentSessionMutationAdmitsNow<TValue>(
  request: Pick<AgentSessionMutationRequest<TValue>, 'store' | 'callerKey' | 'envelope' | 'now'> & {
    plan: Pick<
      MutationPlan<TValue>,
      'method' | 'fields' | 'operationIdScope' | 'conversationWrite' | 'commandReceipt'
    >
  }
): boolean {
  const { plan, envelope } = request
  if (plan.commandReceipt && !receiptAbsent(request)) {
    return false
  }
  const hostFingerprint = computeAgentSessionPayloadFingerprint({
    method: plan.method,
    sessionId: envelope.sessionId,
    fields: plan.fields
  })
  const evaluated = request.store.evaluateMutationOperation({
    callerKey: request.callerKey,
    envelope,
    hostFingerprint,
    now: request.now(),
    ...(plan.operationIdScope ? { operationIdScope: plan.operationIdScope } : {})
  })
  return (
    evaluated !== null &&
    admitAgentSessionMutation({
      envelope,
      hostFingerprint,
      ledger: evaluated.decision,
      lease: evaluated.record.lease,
      ...(plan.conversationWrite ? { conversationWrite: true } : {})
    }).decision === 'admit'
  )
}

function receiptAbsent<TValue>(
  request: Pick<AgentSessionMutationRequest<TValue>, 'store' | 'callerKey' | 'envelope'> & {
    plan: Pick<MutationPlan<TValue>, 'operationIdScope'>
  }
): boolean {
  try {
    return (
      request.store.readCommandReceipt(
        commandReceiptScope(request.callerKey, request.plan.operationIdScope),
        request.envelope.clientOperationId
      ).verdict === 'absent'
    )
  } catch {
    return false
  }
}
