import { mapWithConcurrency } from '../../../../../shared/concurrency/map-with-concurrency'
import type { StructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrchestrationDb } from '../../db/orchestration-db'

/** One chat's mail looked at again: its owned mailboxes redriven, then its queue woken. */
export function wakeChatMail(
  sessionId: string,
  redriveMail: (sessionId: string) => void,
  host: Pick<
    StructuredAgentSessionHost,
    'wakeQueuedMessages'
  > | null = getStructuredAgentSessionHost()
): void {
  try {
    redriveMail(sessionId)
  } catch (error) {
    // One chat's unreadable mailboxes must not cost the others theirs; its queue still wakes.
    console.warn('[orchestration] chat mail redrive failed', { sessionId, error })
  }
  host?.wakeQueuedMessages(sessionId)
}

/** The pass against the installed host and the chats the database says hold mail; never throws. */
export async function redriveWaitingChatMailHere(
  db: OrchestrationDb | null,
  redriveMail: (sessionId: string) => void
): Promise<void> {
  try {
    const host = getStructuredAgentSessionHost()
    if (host) {
      await redriveWaitingChatMail(host, db?.getStructuredMailSendSessions() ?? [], redriveMail)
    }
  } catch (error: unknown) {
    console.warn('[orchestration] waking chat mail after a restart failed', error)
  }
}

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
  const started = performance.now()
  const waiting = await host.deps.journalDatabase.readers.database({
    kind: 'waiting-card-sessions',
    sessionIds: owedMail
  })
  if (waiting.kind !== 'sessions') {
    return
  }
  const woken = await mapWithConcurrency(waiting.sessionIds, 4, async (sessionId) => {
    // Skipped when it can no longer be opened (ended, refused); nothing else would send its mail.
    if (
      await host.conversation(sessionId).then(
        () => true,
        () => false
      )
    ) {
      wakeChatMail(sessionId, redriveMail, host)
      return true
    }
    return false
  })
  console.info('[orchestration] restart mail pass', {
    owedMail: owedMail.length,
    woken: woken.filter(Boolean).length,
    ms: Math.round(performance.now() - started)
  })
}
