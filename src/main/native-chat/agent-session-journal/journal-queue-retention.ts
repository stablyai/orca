import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalQueueCardChange, JournalQueuedChange } from './journal-queue-events'
import type { QueuedMessageRow } from './queued-message-table'
import { finishJournalSteps } from './journal-reconstruction-steps'

/** Restate waiting/returned cards and unhanded submissions before deleting their epoch; preserve refusals. */
export function retainedQueueFacts(
  cards: readonly QueuedMessageRow[],
  submissions: ReadonlyMap<string, AgentJournalSubmission>
): JournalQueueCardChange[] {
  return finishJournalSteps(retainedQueueFactSteps(cards, submissions))
}

export function* retainedQueueFactSteps(
  cards: readonly QueuedMessageRow[],
  submissions: ReadonlyMap<string, AgentJournalSubmission>
): Generator<void, JournalQueueCardChange[]> {
  const result: JournalQueueCardChange[] = []
  for (const card of cards) {
    yield
    const handOff = card.consumedAs === null ? undefined : submissions.get(card.consumedAs)
    const unsent =
      card.state === 'dispatched' &&
      handOff !== undefined &&
      isQueuedAgentJournalSubmission(handOff)
    if (card.state !== 'waiting' && card.state !== 'returned' && !unsent) {
      continue
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
    result.push({ messageId: card.messageId, change })
  }
  return result
}

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

/** Membership outlives automatic eligibility, but not a completed handoff. */
export function isLiveJournalQueueCard(
  card: QueuedMessageRow,
  submissions: ReadonlyMap<string, AgentJournalSubmission>
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
