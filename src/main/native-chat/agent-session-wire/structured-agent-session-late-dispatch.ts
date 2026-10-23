import type {
  AgentJournalAnsweredTurnIdentity,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentJournalDispatchRejection } from '../../../shared/agent-session-failure-words'
import type { ResolveDispatchInput } from '../agent-session-journal/journal-store-contracts'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { whileStructuredAgentSessionHandingOver } from './structured-agent-session-handing-over'

/** Settle a provider-proven outcome independently of an in-flight client mutation. `unknown` is
 *  released doubt: the provider let the send go unanswered, so nothing re-sends it. `unrun`: the
 *  provider reported it never ran the send, which a queued card's hand-off records as proof, so
 *  the card waits again. A direct send keeps the plain refusal: there the proof would owe it as
 *  stopped history. */
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
        unrun?: true
      } & AgentJournalDispatchRejection)
    | { state: 'unknown'; reason: string }
  )
): Promise<void> {
  const session = context.sessions.get(input.sessionId)
  if (!session) {
    return
  }
  const fence = structuredAgentSessionConversationFence(context.deps.store, input.sessionId)
  const unrunCard =
    'state' in input &&
    input.state === 'rejected' &&
    input.unrun === true &&
    session.journal.submission(input.clientMessageId)?.queuedMessageId !== undefined
  const settlement: ResolveDispatchInput =
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
            rejection: unrunCard
              ? { ...input.rejection, neverReachedAgent: true }
              : input.rejection,
            ...(input.answeredInTurn ? { answeredInTurn: input.answeredInTurn } : {}),
            fence
          }
  try {
    // The journal queue drains before close; the host queue would defer this past teardown.
    await whileStructuredAgentSessionHandingOver(
      session.journal,
      input.clientMessageId,
      async () => {
        await (settlement.state === 'accepted'
          ? session.journal.acceptLate(settlement)
          : session.journal.resolveDispatch(settlement))
      }
    )
  } catch (error) {
    context.publishWorkChanged(input.sessionId)
    throw error
  }
}
