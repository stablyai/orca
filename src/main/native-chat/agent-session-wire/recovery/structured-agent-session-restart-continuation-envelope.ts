import { restartConnectorClaim } from './structured-agent-session-connector-claims'
import { agentSessionMessagePayload } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { AgentJournalConnectorClaim } from '../../../../shared/agent-session/journal/agent-journal-bot-message-fields'
import { createHash } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import { restartContinuationMessage } from '../../../../shared/agent-session/lifecycle/stopping/agent-session-restart-continuation'
import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import type { AgentSessionMutationEnvelope } from '../../../../shared/agent-session/agent-session-wire'

export function restartContinuationBody(
  marker: Pick<AgentSessionResumeMarker, 'activity'>,
  claim?: AgentJournalConnectorClaim
): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: restartContinuationMessage(marker) }],
    ...(claim ? { connectorClaim: claim } : {})
  }
}

const hex16 = (parts: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)

/** Shared offer tag across all of its continuation actions. */
function restartOfferTag(marker: AgentSessionResumeMarker): string {
  return hex16([marker.teardownId, marker.sessionId])
}

/** Fresh action IDs avoid failed-send replay; date by action because offers outlive ledger admission windows. */
export function restartContinuationId(
  marker: AgentSessionResumeMarker,
  operationId: string,
  actionAt: number
): string {
  return `${Math.trunc(actionAt).toString().padStart(13, '0')}-${restartOfferTag(marker)}${hex16([
    marker.teardownId,
    marker.sessionId,
    marker.work.kind,
    marker.work.id,
    marker.providerHandleRoot,
    operationId
  ])}`
}

export function isRestartContinuationOf(
  marker: AgentSessionResumeMarker,
  clientMessageId: string
): boolean {
  return /^\d{13}-[0-9a-f]{32}$/.test(clientMessageId)
    ? clientMessageId.slice(14, 30) === restartOfferTag(marker)
    : false
}

/** Fence fills the envelope; operation ID defines send identity. */
export function restartContinuationEnvelope(
  sessionId: string,
  fence: number,
  marker: Pick<AgentSessionResumeMarker, 'activity'>,
  continuationId: string,
  claim?: AgentJournalConnectorClaim
): { envelope: AgentSessionMutationEnvelope; body: AgentJournalMessageItem } {
  const body = restartContinuationBody(marker, claim)
  return {
    body,
    envelope: {
      sessionId,
      clientOperationId: continuationId,
      expectedRuntimeFence: fence,
      // Over what the provider gets, as every send's: a host-written claim never reaches it.
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId,
        fields: { body: agentSessionMessagePayload(body) }
      })
    }
  }
}

/** The envelope a continuation sends: claiming, for its marker's cut, the connector requests that
 *  cut owes (Phase 1). */
export async function continuationEnvelopeOf(
  sessionId: string,
  fence: number,
  marker: Pick<AgentSessionResumeMarker, 'activity'> & { work?: { id: string } },
  continuationId: string
): Promise<{ envelope: AgentSessionMutationEnvelope; body: AgentJournalMessageItem }> {
  const claim = await restartConnectorClaim(sessionId, marker)
  return restartContinuationEnvelope(sessionId, fence, marker, continuationId, claim)
}
