import { mapWithConcurrency } from '../../../../../shared/concurrency/map-with-concurrency'
import type { StructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-host'

/** After restoration, each chat holding orchestration mail as a waiting card gets one look at its
 *  mail and cards: mail walked past while restoration held custody has no later edge in an idle
 *  chat. A closed chat is opened at rest, since its cards drain only while open; one that cannot be
 *  opened or read is skipped. */
export async function redriveWaitingChatMail(
  host: Pick<StructuredAgentSessionHost, 'conversation' | 'wakeQueuedMessages'> | null,
  /** The chats holding orchestration mail as a send or card. */
  owedMail: readonly string[],
  redriveMail: (sessionId: string) => void
): Promise<void> {
  if (!host) {
    return
  }
  await mapWithConcurrency(owedMail, 4, async (sessionId) => {
    const cards = await host
      .conversation(sessionId)
      .then(({ journal }) => journal.queuedMessages.list())
      .catch(() => [])
    if (cards.some((card) => card.state === 'waiting')) {
      redriveMail(sessionId)
      host.wakeQueuedMessages(sessionId)
    }
  })
}
