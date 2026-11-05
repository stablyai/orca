import type { QueuedMessageRow } from './queued-message-table'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'

export function hasQueuedReopenWork(
  cards: readonly QueuedMessageRow[],
  submissions: ReadonlyMap<string, AgentJournalSubmission>
): boolean {
  return cards.some((card) => {
    if (card.state === 'waiting') {
      return true
    }
    const handOff = card.consumedAs ? submissions.get(card.consumedAs) : undefined
    // Recovered uncertainty cannot return a card to waiting.
    return (
      card.state === 'dispatched' &&
      (handOff?.dispatchState === 'pending' ||
        (handOff?.dispatchState === 'unknown' && handOff.recovered !== true))
    )
  })
}
