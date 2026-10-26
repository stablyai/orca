import type { AgentSessionSendResult } from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

/** Refused conversions replay as returned cards, avoiding duplicate Retry rows; null means never queued. */
export function queuedSendAnswer(
  journal: Pick<AgentSessionJournal, 'queuedMessages' | 'submission' | 'submissions'>,
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
