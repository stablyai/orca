// What a send this host queued answers with when it is asked again — a lost
// acknowledgement's replay, or a rerun the operation ledger no longer covers:
// from its draft first, then from the hand-off that names it.

import type { AgentSessionSendResult } from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

/** Null for a send this host never queued. A refused conversion answers with
 *  its returned card, never the rejected submission, or the same text would
 *  render twice — on a Retry row AND the card. */
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
      ? { clientMessageId, submission: consumed }
      : {
          clientMessageId,
          queued: { messageId: draft.messageId, position: draft.position, state: draft.state }
        }
  }
  // The draft row was pruned; its last hand-off still names it. Only a withdrawn row is pruned
  // while its last hand-off stands rejected — a card the user deleted — so it answers withdrawn,
  // never as a refused send.
  const handoff = journal
    .submissions()
    .findLast((entry) => entry.queuedMessageId === clientMessageId)
  if (handoff?.dispatchState === 'rejected') {
    // The pruned row's position went with it; a withdrawn receipt names no place in the queue.
    return {
      clientMessageId,
      queued: { messageId: clientMessageId, position: 0, state: 'withdrawn' }
    }
  }
  return handoff ? { clientMessageId, submission: handoff } : null
}
