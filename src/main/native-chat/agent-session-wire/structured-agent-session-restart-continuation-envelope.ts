import { createHash } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { restartContinuationMessage } from '../../../shared/agent-session-restart-continuation'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'

export function restartContinuationBody(
  marker: Pick<AgentSessionResumeMarker, 'activity'>
): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: restartContinuationMessage(marker) }]
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
  continuationId: string
): { envelope: AgentSessionMutationEnvelope; body: AgentJournalMessageItem } {
  const body = restartContinuationBody(marker)
  return {
    body,
    envelope: {
      sessionId,
      clientOperationId: continuationId,
      expectedRuntimeFence: fence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId,
        fields: { body }
      })
    }
  }
}
