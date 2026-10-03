import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

/** Only thrown while the provider dispatch is still unreachable. */
export class AgentSessionPreDispatchError extends Error {
  constructor(code: string) {
    super(code)
    this.name = 'AgentSessionPreDispatchError'
  }
}

export async function runSettledAgentSessionMutation<TValue>(input: {
  store: AgentSessionRecordStore
  operationCallerKey: string
  envelope: AgentSessionMutationEnvelope
  plan: MutationPlan<TValue>
  context: AgentSessionTurnContext
}): Promise<TurnOutcome<TValue>> {
  const settle = (
    outcome: Parameters<AgentSessionRecordStore['recordOperationOutcome']>[0]['outcome']
  ) =>
    input.store.recordOperationOutcome({
      callerKey: input.operationCallerKey,
      operationId: input.envelope.clientOperationId,
      outcome
    })
  let outcome: TurnOutcome<TValue> | undefined
  try {
    if (input.plan.markUnknownBeforeRun) {
      await settle({ status: 'unknown' })
    }
    outcome = await input.plan.run(input.context)
    await settle(
      outcome.ok
        ? (input.plan.settledOutcome?.(outcome.value) ?? {
            status: 'succeeded',
            sessionId: input.envelope.sessionId
          })
        : {
            status: 'failed',
            code: outcome.refusal.code,
            ...(outcome.refusal.details ? { details: outcome.refusal.details } : {}),
            // The row's own field, which builds before details read; copied from the legacy mirror.
            ...(outcome.refusal.rewindReason ? { rewindReason: outcome.refusal.rewindReason } : {})
          }
    )
    return outcome
  } catch (error) {
    // The pre-run uncertainty is already durable; refusing before dispatch adds no new uncertainty.
    if (input.plan.markUnknownBeforeRun && error instanceof AgentSessionPreDispatchError) {
      throw error
    }
    const { logger, sessionId } = input.context
    try {
      await settle({ status: 'unknown' })
    } catch {
      // Bookkeeping must not replace the operation's proof of whether dispatch began.
      logger.warn('recording an operation as unknown failed', {
        scope: 'operation-unknown-settlement',
        sessionId,
        operationId: input.envelope.clientOperationId
      })
    }
    if (outcome && !outcome.ok) {
      logger.warn('recording a refused operation failed', {
        scope: 'operation-refused-settlement',
        sessionId,
        operationId: input.envelope.clientOperationId
      })
      return outcome
    }
    throw error
  }
}
