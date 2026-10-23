// What of the queue a new epoch restates. Replacing or rolling over an epoch deletes its rows,
// the cards' rows and their hand-offs with them, so every card still owed an answer is written
// again in the deleting transaction, the way the queue's pauses are.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { JournalQueueCardChange, JournalQueuedChange } from './journal-queue-events'
import type { QueuedMessageRow } from './queued-message-table'

/**
 * THE retention rule, one for replacement and rollover: a waiting card; a returned one, with its
 * refusal written down because its own rows are going; and a card handed off as a send not yet
 * handed over, which provably never reached the agent and so waits again (a replacement's carried
 * submission relinks it). Everything else is answered, or can no longer be.
 */
export function retainedQueueFacts(
  cards: readonly QueuedMessageRow[],
  submissions: ReadonlyMap<string, AgentJournalSubmission>
): JournalQueueCardChange[] {
  return cards.flatMap((card) => {
    const handOff = card.consumedAs === null ? undefined : submissions.get(card.consumedAs)
    const unsent =
      card.state === 'dispatched' &&
      handOff !== undefined &&
      isQueuedAgentJournalSubmission(handOff)
    if (card.state !== 'waiting' && card.state !== 'returned' && !unsent) {
      return []
    }
    const change: JournalQueuedChange = {
      ...queuedChangeOf(card),
      ...(card.state === 'waiting' && card.holdReason !== null
        ? { holdReason: card.holdReason }
        : {}),
      ...(card.state === 'returned'
        ? {
            ...(card.consumedAs !== null ? { attempt: card.consumedAs } : {}),
            returned: {
              reason: card.returnedReason,
              ...(card.returnedRejection ? { rejection: card.returnedRejection } : {})
            }
          }
        : {})
    }
    return [{ messageId: card.messageId, change }]
  })
}

/** A card's own fields as a `queued` change: its text, place, time and options. */
export function queuedChangeOf(
  card: Pick<QueuedMessageRow, 'body' | 'position' | 'queuedAt' | 'options'>
): JournalQueuedChange {
  return {
    op: 'queued',
    body: card.body,
    position: card.position,
    queuedAt: card.queuedAt,
    ...(card.options ? { options: card.options } : {})
  }
}
