import type { StructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { OrchestrationDb } from '../../db/orchestration-db'

/** After restoration, each chat with a waiting card gets one look at its mail and cards: mail walked
 *  past while restoration held custody has no later edge in an idle chat. A closed chat is opened
 *  only when it holds orchestration mail. */
export async function redriveWaitingChatMail(
  host: Pick<
    StructuredAgentSessionHost,
    'sessionsWithWaitingQueuedMessages' | 'wakeQueuedMessages'
  > | null,
  db: Pick<OrchestrationDb, 'getStructuredMailSendSessions'> | null,
  redriveMail: (sessionId: string) => void
): Promise<void> {
  const owedMail = db?.getStructuredMailSendSessions() ?? []
  for (const sessionId of (await host?.sessionsWithWaitingQueuedMessages(owedMail)) ?? []) {
    redriveMail(sessionId)
    host?.wakeQueuedMessages(sessionId)
  }
}
