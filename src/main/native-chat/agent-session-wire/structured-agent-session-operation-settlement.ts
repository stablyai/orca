import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import {
  AgentSessionPreEffectPersistenceError,
  type AgentSessionTurnContext,
  type TurnOutcome
} from './structured-agent-session-turns'

export async function runSettledAgentSessionMutation<TValue>(input: {
  store: AgentSessionRecordStore
  callerKey: string
  envelope: AgentSessionMutationEnvelope
  plan: MutationPlan<TValue>
  context: AgentSessionTurnContext
}): Promise<TurnOutcome<TValue>> {
  const settle = (
    outcome: Parameters<AgentSessionRecordStore['recordOperationOutcome']>[0]['outcome']
  ) =>
    input.store.recordOperationOutcomeIfCurrent({
      callerKey: input.callerKey,
      operationId: input.envelope.clientOperationId,
      outcome,
      current: 'unsettled'
    })
  try {
    const outcome = await input.plan.run(input.context)
    await settle(
      outcome.ok
        ? (input.plan.settledOutcome?.(outcome.value) ?? {
            status: 'succeeded',
            sessionId: input.envelope.sessionId
          })
        : {
            status: 'failed',
            code: outcome.refusal.code,
            ...(outcome.refusal.rewindReason ? { rewindReason: outcome.refusal.rewindReason } : {})
          }
    )
    return outcome
  } catch (error) {
    if (error instanceof AgentSessionPreEffectPersistenceError) {
      throw error.original
    }
    await input.store.recordOperationOutcomeIfCurrent({
      callerKey: input.callerKey,
      operationId: input.envelope.clientOperationId,
      outcome: { status: 'unknown' },
      current: 'pending'
    })
    throw error
  }
}
