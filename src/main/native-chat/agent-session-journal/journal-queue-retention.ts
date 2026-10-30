import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { JournalQueueCardChange, JournalQueuedChange } from './journal-queue-events'
import type { QueuedMessageRow } from './queued-message-table'

/** Restate waiting/returned cards and unhanded submissions before deleting their epoch; preserve refusals. */
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

export function queuedChangeOf(
  card: Pick<QueuedMessageRow, 'body' | 'position' | 'queuedAt' | 'options' | 'mailSource'>
): JournalQueuedChange {
  return {
    op: 'queued',
    body: card.body,
    position: card.position,
    queuedAt: card.queuedAt,
    ...(card.mailSource ? { mailSource: card.mailSource } : {}),
    ...(card.options ? { options: card.options } : {})
  }
}
