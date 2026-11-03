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
