import type {
  AgentJournalAnsweredTurnIdentity,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentJournalDispatchRejection } from '../../../shared/agent-session-failure-words'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'

/** Settle a provider-proven outcome independently of an in-flight client mutation. `unknown` is
 *  released doubt: the provider let the send go unanswered, so nothing re-sends it. */
export async function settleStructuredAgentSessionLateDispatch(
  context: StructuredAgentSessionMutationContext,
  input: {
    sessionId: string
    clientMessageId: string
  } & (
    | { providerIdentity: AgentJournalItemIdentity }
    | ({
        state: 'rejected'
        answeredInTurn?: AgentJournalAnsweredTurnIdentity
      } & AgentJournalDispatchRejection)
    | { state: 'unknown'; reason: string }
  )
): Promise<void> {
  const session = context.sessions.get(input.sessionId)
  if (!session) {
    return
  }
  const fence = structuredAgentSessionConversationFence(context.deps.store, input.sessionId)
  // The journal queue drains before close; the host queue would defer this past teardown.
  await session.journal.resolveDispatch(
    'providerIdentity' in input
      ? {
          clientMessageId: input.clientMessageId,
          state: 'accepted',
          providerIdentity: input.providerIdentity,
          fence
        }
      : input.state === 'unknown'
        ? {
            clientMessageId: input.clientMessageId,
            state: 'unknown',
            reason: input.reason,
            fence,
            recovered: true
          }
        : {
            clientMessageId: input.clientMessageId,
            state: 'rejected',
            reason: input.reason,
            rejection: input.rejection,
            ...(input.answeredInTurn ? { answeredInTurn: input.answeredInTurn } : {}),
            fence
          }
  )
}
