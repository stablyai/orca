// A status line Orca writes into a bot's chat, as the journal shows it: no turn, no notification.
import { randomUUID } from 'node:crypto'
import type { AgentJournalPlainStatusItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** An Orca status line in a chat; a failed write is logged, never thrown. */
export function noteInChat(sessionId: string | undefined, text: string): void {
  writeInChat(sessionId, { kind: 'status', text }, 'look-around')
}

/** A status line or card in a chat; a failed write is logged, never thrown. */
export function writeInChat(
  sessionId: string | undefined,
  body: AgentJournalPlainStatusItem,
  idPrefix: string,
  options: {
    /** A caller-chosen id, so a retry with the same id writes one row; defaults to a fresh one. */
    messageId?: string
    /** The warning shown when the write fails. */
    failureLog?: string
  } = {}
): void {
  if (!sessionId) {
    return
  }
  const failureLog = options.failureLog ?? '[bots] chat status line failed'
  try {
    const host = getStructuredAgentSessionHost()
    const destination = host?.captureAgentStartDestination(sessionId)
    if (host && destination) {
      const line = { body, messageId: options.messageId ?? `${idPrefix}:${randomUUID()}` }
      void destination
        .then((captured) => captured && host.appendAgentStart(captured, line, Date.now()))
        .catch((error: unknown) => console.warn(failureLog, error))
    }
  } catch (error) {
    console.warn(failureLog, error)
  }
}
