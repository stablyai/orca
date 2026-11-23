import { mapWithConcurrency } from '../../../../../shared/concurrency/map-with-concurrency'
import type { StructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-host'

/** After restoration, each chat holding orchestration mail as a waiting card gets one look at its
 *  mail and cards: mail walked past while restoration held custody has no later edge in an idle
 *  chat. One indexed read picks the chats with a waiting card; only those are opened at rest (cards
 *  drain only while open), so the work is the mail actually owed. */
export async function redriveWaitingChatMail(
  host: Pick<StructuredAgentSessionHost, 'conversation' | 'wakeQueuedMessages'> & {
    deps: Pick<StructuredAgentSessionHost['deps'], 'journalDatabase'>
  },
  /** The chats holding orchestration mail as a send or card. */
  owedMail: readonly string[],
  redriveMail: (sessionId: string) => void
): Promise<void> {
  if (owedMail.length === 0) {
    return
  }
  const waiting = await host.deps.journalDatabase.readers.database({
    kind: 'waiting-card-sessions',
    sessionIds: owedMail
  })
  if (waiting.kind !== 'sessions') {
    return
  }
  await mapWithConcurrency(waiting.sessionIds, 4, async (sessionId) => {
    // Skipped when it can no longer be opened (ended, refused); nothing else would send its mail.
    if (await host.conversation(sessionId).then(() => true, () => false)) {
      redriveMail(sessionId)
      host.wakeQueuedMessages(sessionId)
    }
  })
}
