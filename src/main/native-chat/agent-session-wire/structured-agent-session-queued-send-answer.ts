import type { AgentSessionSendResult } from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'

/** Refused conversions replay as returned cards, avoiding duplicate Retry rows; null means never queued. */
export function queuedSendAnswer(
  journal: Pick<AgentSessionJournal, 'submission' | 'submissions'> & {
    queuedMessages: Pick<AgentSessionJournal['queuedMessages'], 'get'>
  },
  clientMessageId: string
): AgentSessionSendResult | null {
  const draft = journal.queuedMessages.get(clientMessageId)
  if (draft) {
    const consumed =
      draft.state === 'dispatched' && draft.consumedAs !== null
        ? journal.submission(draft.consumedAs)
        : undefined
    return consumed
      ? { clientMessageId, submission: { ...consumed } }
      : {
          clientMessageId,
          queued: { messageId: draft.messageId, position: draft.position, state: draft.state }
        }
  }
  // Missing cards with rejected handoffs were deleted; replay withdrawn rather than a refused send.
  const handoff = journal
    .submissions()
    .findLast((entry) => entry.queuedMessageId === clientMessageId)
  if (handoff?.dispatchState === 'rejected') {
    return {
      clientMessageId,
      queued: { messageId: clientMessageId, position: 0, state: 'withdrawn' }
    }
  }
  return handoff ? { clientMessageId, submission: { ...handoff } } : null
}

/** What one send became, with the journal positions a retry after its rejection is judged by. */
export type StructuredSendFacts = {
  answer: AgentSessionSendResult | null
  /** On a rejected send: where its rejection landed. */
  rejectedAt?: number
  /** Where the latest provider-accepted turn and the latest /clear landed; zero when none. */
  acceptedTurnAt: number
  clearedAt: number
}

/** Read by key, so a caller with many sends does not scan history for each: the card, the handoff
 *  it became, or the send itself. Only a card that is gone falls back to the handoff scan. */
export function structuredSendFacts(
  journal: Pick<AgentSessionJournal, 'submission' | 'submissions' | 'item'> & {
    queuedMessages: Pick<AgentSessionJournal['queuedMessages'], 'get' | 'inputState'>
  },
  clientMessageId: string
): StructuredSendFacts {
  const immediate = journal.queuedMessages.get(clientMessageId)
    ? undefined
    : journal.submission(clientMessageId)
  const answer = immediate
    ? { clientMessageId, submission: { ...immediate } }
    : queuedSendAnswer(journal, clientMessageId)
  const submission = answer && 'submission' in answer ? answer.submission : undefined
  // A proven rejection is placed at its settlement row.
  const rejectedAt =
    submission?.dispatchState === 'rejected'
      ? journal.item(agentJournalSubmissionKey(submission.clientMessageId))?.sequence
      : undefined
  const { latestAcceptedTurnSequence, queuePauseMarks } = journal.queuedMessages.inputState()
  return {
    answer,
    ...(rejectedAt !== undefined && { rejectedAt }),
    acceptedTurnAt: latestAcceptedTurnSequence,
    clearedAt: queuePauseMarks.cleared?.sequence ?? 0
  }
}
