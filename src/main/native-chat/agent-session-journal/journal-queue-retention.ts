import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { JournalQueuedChange } from './journal-queue-events'
import type { QueuedMessageRow } from './queued-message-table'

/** A card's own fields as a `queued` change: its text, place, time and options. */
export function queuedChangeOf(
  card: Pick<QueuedMessageRow, 'body' | 'position' | 'queuedAt' | 'options' | 'recovers'>
): JournalQueuedChange {
  return {
    op: 'queued',
    body: card.body,
    position: card.position,
    queuedAt: card.queuedAt,
    ...(card.options ? { options: card.options } : {}),
    ...(card.recovers ? { recovers: card.recovers } : {})
  }
}

export function queueNeedsReopen(
  cards: readonly QueuedMessageRow[],
  submissions: ReadonlyMap<string, AgentJournalSubmission>
): boolean {
  return cards.some((card) => {
    if (card.state === 'waiting') {
      return true
    }
    const handOff = card.consumedAs ? submissions.get(card.consumedAs) : undefined
    // A recovered doubt outlived its writer: nothing brings that card back to waiting.
    return (
      card.state === 'dispatched' &&
      (handOff?.dispatchState === 'pending' ||
        (handOff?.dispatchState === 'unknown' && handOff.recovered !== true))
    )
  })
}
