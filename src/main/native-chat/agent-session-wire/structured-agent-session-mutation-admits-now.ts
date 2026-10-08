import {
  admitAgentSessionMutation,
  computeAgentSessionPayloadFingerprint
} from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationRequest } from './structured-agent-session-mutation-admission'
import type { MutationPlan } from './structured-agent-session-mutation-plans'

/** Whether admission would run `plan` for the first time now, placing nothing: for an effect that
 *  must not wait in the session's queue for its turn. */
export function agentSessionMutationAdmitsNow<TValue>(
  request: Pick<AgentSessionMutationRequest<TValue>, 'store' | 'callerKey' | 'envelope' | 'now'> & {
    plan: Pick<MutationPlan<TValue>, 'method' | 'fields' | 'operationIdScope' | 'conversationWrite'>
  }
): boolean {
  const { plan, envelope } = request
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
