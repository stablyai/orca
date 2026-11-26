import type { JournalKeyedRead } from '../journal-keyed-storage'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'

import type { JournalQueuedChange } from './journal-queue-events'
import type { QueuedMessageRow } from './queued-message-table'

/** A card's own fields as a `queued` change: its text, place, time and options. */
export function queuedChangeOf(
  card: Pick<
    QueuedMessageRow,
    'body' | 'position' | 'queuedAt' | 'options' | 'recovers' | 'deliveryMode' | 'unattended'
  >
): JournalQueuedChange {
  return {
    op: 'queued',
    body: card.body,
    position: card.position,
    queuedAt: card.queuedAt,
    ...(card.options ? { options: card.options } : {}),
    ...(card.deliveryMode !== undefined ? { deliveryMode: card.deliveryMode } : {}),
    ...(card.unattended !== undefined ? { unattended: card.unattended } : {}),
    ...(card.recovers ? { recovers: card.recovers } : {})
  }
}

/** Membership outlives automatic eligibility, but not a completed handoff. */
export function isLiveJournalQueueCard(
  card: QueuedMessageRow,
  submissions: JournalKeyedRead<string, AgentJournalSubmission>
): boolean {
  const handoff = card.consumedAs ? submissions.get(card.consumedAs) : undefined
  return (
    card.state === 'waiting' ||
    card.state === 'returned' ||
    (card.state === 'dispatched' &&
      handoff !== undefined &&
      isQueuedAgentJournalSubmission(handoff))
  )
}

export function queueNeedsReopen(
  cards: readonly QueuedMessageRow[],
  submissions: JournalKeyedRead<string, AgentJournalSubmission>
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
