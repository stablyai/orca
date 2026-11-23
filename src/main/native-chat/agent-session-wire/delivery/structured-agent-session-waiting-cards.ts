import { mapWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'
import type { StructuredAgentSessionHostSession } from '../host/structured-agent-session-host-types'

/** The open chats and `owedMail`'s with a card still waiting, each opened at rest (its cards drain
 *  only while open). A chat that cannot be opened or read is skipped. */
export const waitingCardsLookup =
  (
    open: ReadonlyMap<string, unknown>,
    conversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession>
  ) =>
  async (owedMail: readonly string[] = []): Promise<string[]> => {
    const ids = [...new Set([...open.keys(), ...owedMail])]
    const waiting = await mapWithConcurrency(ids, 4, async (sessionId) => {
    const cards = await conversation(sessionId)
      .then(({ journal }) => journal.queuedMessages.list())
      .catch(() => [])
    return cards.some((card) => card.state === 'waiting') ? [sessionId] : []
  })
  return waiting.flat()
}
