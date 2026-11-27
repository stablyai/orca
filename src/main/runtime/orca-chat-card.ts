import type { AgentJournalOrcaCardItem } from '../../shared/agent-journal-orca-card-items'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** Writes one of Orca's cards into a chat this host runs; never fails what it reports. */
export async function appendOrcaChatCard(
  sessionId: string,
  body: AgentJournalOrcaCardItem,
  what: string
): Promise<boolean> {
  const fail = (error: unknown): false => {
    console.warn(`[orca-chat-card] ${what} failed`, error)
    return false
  }
  try {
    const host = getStructuredAgentSessionHost()
    // Null for a session this host doesn't run, so a chat on another host never gets the card.
    const destination = host?.captureAgentStartDestination(sessionId)
    if (!host || !destination) {
      return true
    }
    const captured = await destination
    if (!captured) {
      return false
    }
    return (await host.appendAgentStart(captured, body, Date.now())) !== false
  } catch (error) {
    return fail(error)
  }
}
