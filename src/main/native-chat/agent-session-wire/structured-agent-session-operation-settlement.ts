import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

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
    input.store.recordOperationOutcome({
      callerKey: input.callerKey,
      operationId: input.envelope.clientOperationId,
      outcome
    })
  try {
    const outcome = await input.plan.run(input.context)
    await settle(
      outcome.ok
        ? { status: 'succeeded', sessionId: input.envelope.sessionId }
        : { status: 'failed', code: outcome.refusal.code }
    )
    return outcome
  } catch (error) {
    await settle({ status: 'unknown' })
    throw error
  }
}
