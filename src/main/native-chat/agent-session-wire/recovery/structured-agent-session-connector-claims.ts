import type { AgentJournalConnectorClaim } from '../../../../shared/agent-session/journal/agent-journal-bot-message-fields'
import type { JournalConnectorReplyCut } from '../../../../shared/agent-session/journal/journal-connector-reply'

/** What a continuation about to be sent for a cut claims of the connector requests the cut owed
 *  (Phase 1): the reply outbox's recovery answers it, when connectors run. */
export type ConnectorClaimSource = (
  sessionId: string,
  cut: JournalConnectorReplyCut
) => Promise<AgentJournalConnectorClaim | undefined>

let source: ConnectorClaimSource | null = null

/** The running connectors' claim source; null when they stop. */
export function setConnectorClaimSource(next: ConnectorClaimSource | null): void {
  source = next
}

/** A claim never holds up a continuation: without connectors, or when reading fails, it claims
 *  nothing and its requests end as their cut does. */
export async function connectorClaimFor(
  sessionId: string,
  cut: JournalConnectorReplyCut
): Promise<AgentJournalConnectorClaim | undefined> {
  try {
    return (await source?.(sessionId, cut)) ?? undefined
  } catch (error) {
    console.warn('[agent-session] claiming connector requests for a continuation failed', error)
    return undefined
  }
}

/** A restart continuation's claim: for its marker's cut, when the marker names one. */
export function restartConnectorClaim(
  sessionId: string,
  marker: { work?: { id: string } }
): Promise<AgentJournalConnectorClaim | undefined> {
  return marker.work
    ? connectorClaimFor(sessionId, { turnId: marker.work.id, kind: 'restart' })
    : Promise.resolve(undefined)
}
