import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { deriveContextTransferState } from '../agent-session-journal/context-transfer-state'
import { RecoveryContextBudgetError } from '../agent-session-context-transfer-text'
import { StructuredAgentSessionInputNotAdmitted } from './structured-agent-session-input-admission'
import type { AgentSessionHandoverContext } from './structured-agent-session-host-types'
import { prepareRecoveryDelivery } from './structured-agent-session-recovery-delivery'

/** One preparation per actual target; the pending callback co-commits first-input and inline facts. */
export function prepareRecoveryCarrier(ctx: AgentSessionHandoverContext, clientMessageId: string) {
  const state = deriveContextTransferState(
    ctx.journal.contextTransfers.read(),
    ctx.record()?.providerHandleChain ?? []
  )
  const required = state.kind !== 'none' && state.kind !== 'settled'
  return {
    required,
    async run(
      body: AgentJournalMessageItem,
      commit: (run: () => Promise<void>) => Promise<void>,
      isCurrent: () => boolean,
      pending: () => Promise<void>,
      signal?: AbortSignal
    ): Promise<AgentJournalMessageItem> {
      if (!required) {
        return body
      }
      try {
        const delivered = await prepareRecoveryDelivery(
          ctx,
          clientMessageId,
          body,
          state,
          signal
        ).beforeCarrier(commit, isCurrent)
        await commit(async () => {
          signal?.throwIfAborted()
          if (!isCurrent()) {
            throw new Error('Context carrier lost its provider child')
          }
          await pending()
        })
        return delivered
      } catch (error) {
        if (error instanceof StructuredAgentSessionInputNotAdmitted) {
          throw error
        }
        throw new StructuredAgentSessionInputNotAdmitted({
          state: 'rejected',
          ...agentSessionFailureWords(
            agentSessionFailureFact(
              error instanceof RecoveryContextBudgetError ? 'historyTooLarge' : 'providerRejected',
              { neverReachedAgent: true }
            ),
            { ...ctx.failureTextContext, surface: 'rejection' }
          )
        })
      }
    }
  }
}
