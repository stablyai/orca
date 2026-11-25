import type { AgentJournalOrcaCardItem } from '../../shared/agent-journal-orca-card-items'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** Writes one of Orca's cards into a chat this host runs; never fails what it reports. */
export function appendOrcaChatCard(
  sessionId: string,
  body: AgentJournalOrcaCardItem,
  what: string
): void {
  const fail = (error: unknown) => console.warn(`[orca-chat-card] ${what} failed`, error)
  try {
    const host = getStructuredAgentSessionHost()
    // Null for a session this host doesn't run, so a chat on another host never gets the card.
    const destination = host?.captureAgentStartDestination(sessionId)
    if (!host || !destination) {
      return
    }
    void destination
      .then((captured) => captured && host.appendAgentStart(captured, body, Date.now()))
      .catch(fail)
  } catch (error) {
    fail(error)
  }
}
