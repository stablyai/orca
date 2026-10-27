import type { AgentSessionHandoverContext } from './structured-agent-session-host-types'
import type { AgentSessionDispatchOutcome } from './structured-agent-session-adapter'
import { DISPATCH_DOUBT_PERSISTENCE_FAILED } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import type {
  AgentSessionOperationReceipt,
  AgentSessionTurnContext,
  TurnOutcome
} from './structured-agent-session-turns'

/** Proves dispatch was unreachable. */
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
  plan: Exclude<MutationPlan<TValue>, { commandReceipt: object }>
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
        input.store,
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
    if (receipt?.isCommitted() && !ran.ok) {
      // Refusal after committed acceptance is an internal fault, even if post-COMMIT folding failed.
      throw new Error(
        `operation ${operation.operationId} was accepted, then refused: ${ran.refusal.code}`
      )
    }
    if (receipt?.isCommitted()) {
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
            // Preserve the legacy mirror for builds predating refusal details.
            ...(outcome.refusal.rewindReason ? { rewindReason: outcome.refusal.rewindReason } : {})
          }
    )
    return outcome
  } catch (error) {
    const { logger, sessionId } = input.context
    // Atomic effect settlement leaves pending on throw because no write committed.
    if (!input.plan.settlesWithWrite) {
      try {
        await settle({ status: 'unknown' })
      } catch {
        // Bookkeeping cannot replace the original proof of dispatch reachability.
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

/** Track committed acceptance so Stop can save a standalone receipt before acting. */
export function observedReceipt(
  store: Pick<AgentSessionRecordStore, 'commitOperationReceipt'>,
  receipt: JournalOperationReceipt
): AgentSessionOperationReceipt {
  let committed = false
  const observed: AgentSessionOperationReceipt = {
    write: receipt.write,
    committed: () => {
      receipt.committed()
      committed = true
    },
    isCommitted: () => committed,
    commitAlone: async () => {
      if (!committed) {
        await store.commitOperationReceipt(observed)
      }
    }
  }
  return observed
}

export async function resolveHandover(
  ctx: AgentSessionHandoverContext,
  clientMessageId: string,
  outcome: AgentSessionDispatchOutcome | null
): Promise<void> {
  if (!outcome || outcome.state === 'admitted') {
    return
  }
  try {
    await ctx.journal.resolveDispatch(
      outcome.state === 'accepted'
        ? {
            clientMessageId,
            state: 'accepted',
            providerIdentity: outcome.providerIdentity,
            fence: ctx.fence
          }
        : outcome.state === 'rejected'
          ? {
              clientMessageId,
              state: 'rejected',
              reason: outcome.reason,
              rejection: outcome.rejection,
              ...(outcome.answeredInTurn ? { answeredInTurn: outcome.answeredInTurn } : {}),
              fence: ctx.fence
            }
          : {
              clientMessageId,
              state: 'unknown',
              reason: outcome.reason,
              fence: ctx.fence
            }
    )
  } catch (error) {
    // Persist uncertainty if settlement fails; next-open recovery handles any remaining pending row.
    try {
      await ctx.journal.resolveDispatch({
        clientMessageId,
        state: 'unknown',
        reason: DISPATCH_DOUBT_PERSISTENCE_FAILED,
        fence: ctx.fence
      })
    } catch {}
    throw error
  }
}
