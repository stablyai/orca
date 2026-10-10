import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
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
  plan: Exclude<MutationPlan<TValue>, { acceptsWithCommandReceipt: true }>
  context: AgentSessionTurnContext
}): Promise<TurnOutcome<TValue>> {
  const operation = {
    callerKey: input.operationCallerKey,
    operationId: input.envelope.clientOperationId
  }
  const settle = (
    outcome: Parameters<AgentSessionRecordStore['recordOperationOutcome']>[0]['outcome']
  ) => input.store.recordOperationOutcome({ ...operation, outcome })
  const receipt = input.plan.settlesWithWrite
    ? observedReceipt(
        input.plan.successReceipt?.() ??
          input.store.operationOutcomeReceipt({
            ...operation,
            outcome: { status: 'succeeded', sessionId: input.envelope.sessionId }
          })
      )
    : undefined
  const context = receipt ? { ...input.context, operationReceipt: receipt } : input.context
  let outcome: TurnOutcome<TValue> | undefined
  try {
    const ran = await input.plan.run(context)
    if (receipt?.wasCommitted() && !ran.ok) {
      // The row says accepted, so a refusal past it (a fold that failed after COMMIT) is a fault.
      throw new Error(
        `operation ${operation.operationId} was accepted, then refused: ${ran.refusal.code}`
      )
    }
    if (receipt?.wasCommitted()) {
      return ran
    }
    outcome = ran
    await settle(
      outcome.ok
        ? (input.plan.settledOutcome?.(outcome.value) ?? {
            status: 'succeeded',
            sessionId: input.envelope.sessionId
          })
        : {
            status: 'failed',
            code: outcome.refusal.code,
            message: outcome.refusal.message,
            ...(outcome.refusal.details ? { details: outcome.refusal.details } : {}),
            // The row's own field, which builds before details read; copied from the legacy mirror.
            ...(outcome.refusal.rewindReason ? { rewindReason: outcome.refusal.rewindReason } : {})
          }
    )
    return outcome
  } catch (error) {
    const { logger, sessionId } = input.context
    // Its success commits with its write, so a throw leaves the row pending: nothing was written.
    if (!input.plan.settlesWithWrite) {
      try {
        await settle({ status: 'unknown' })
      } catch {
        // Bookkeeping must not replace the operation's proof of whether dispatch began.
        logger.warn('recording an operation as unknown failed', {
          scope: 'operation-unknown-settlement',
          sessionId,
          operationId: operation.operationId
        })
      }
    }
    if (outcome && !outcome.ok) {
      logger.warn('recording a refused operation failed', {
        scope: 'operation-refused-settlement',
        sessionId,
        operationId: operation.operationId
      })
      return outcome
    }
    throw error
  }
}

function observedReceipt(
  receipt: JournalOperationReceipt
): JournalOperationReceipt & { wasCommitted: () => boolean } {
  let committed = false
  return {
    write: receipt.write,
    committed: () => {
      receipt.committed()
      committed = true
    },
    wasCommitted: () => committed
  }
}
