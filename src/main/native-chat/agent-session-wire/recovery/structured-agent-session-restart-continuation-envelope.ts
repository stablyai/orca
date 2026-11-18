import { createHash } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import { restartContinuationMessage } from '../../../../shared/agent-session/lifecycle/stopping/agent-session-restart-continuation'
import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import type { AgentSessionMutationEnvelope } from '../../../../shared/agent-session/agent-session-wire'

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
export function restartOfferTag(
  marker: Pick<AgentSessionResumeMarker, 'teardownId' | 'sessionId'>
): string {
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

/** When a continuation-shaped id was sent and which offer tag it carries; a person's send has the shape too. */
export function readRestartContinuationId(
  clientMessageId: string
): { sentAt: number; offerTag: string } | null {
  return /^\d{13}-[0-9a-f]{32}$/.test(clientMessageId)
    ? { sentAt: Number(clientMessageId.slice(0, 13)), offerTag: clientMessageId.slice(14, 30) }
    : null
}

export function isRestartContinuationOf(
  marker: AgentSessionResumeMarker,
  clientMessageId: string
): boolean {
  return readRestartContinuationId(clientMessageId)?.offerTag === restartOfferTag(marker)
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
