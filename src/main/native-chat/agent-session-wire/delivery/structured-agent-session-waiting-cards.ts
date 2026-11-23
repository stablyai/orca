import { mapWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'
import type { StructuredAgentSessionHostSession } from '../host/structured-agent-session-host-types'

/** Of `sessionIds`, the chats with a card still waiting, each opened at rest (its cards drain only
 *  while open). A chat that cannot be opened or read is skipped. */
export async function chatsWithWaitingCards(
  sessionIds: Iterable<string>,
  conversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession>
): Promise<string[]> {
  const waiting = await mapWithConcurrency([...new Set(sessionIds)], 4, async (sessionId) => {
    const cards = await conversation(sessionId)
      .then(({ journal }) => journal.queuedMessages.list())
      .catch(() => [])
    return cards.some((card) => card.state === 'waiting') ? [sessionId] : []
  })
  return waiting.flat()
}
