// The restart continuation as a message: its body, which depends on the marker alone, and its
// identity, which is one per resume action.

import { createHash } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { restartContinuationMessage } from '../../../shared/agent-session-restart-continuation'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'

/** The message body, built once so both the send and any test read the same text. */
export function restartContinuationBody(marker: AgentSessionResumeMarker): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: restartContinuationMessage(marker) }]
  }
}

const hex16 = (parts: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)

/** Names the offer: every continuation any of its actions sends carries it, and nothing else does. */
function restartOfferTag(marker: AgentSessionResumeMarker): string {
  return hex16([marker.teardownId, marker.sessionId])
}

/** One resume action's continuation: the offer's tag, then the action's own part, so a retry is a
 *  new message, never a replay of the one that failed. Dated by the action, not the quit: the
 *  ledger refuses a new id dated more than a day back, and an offer has no expiry. */
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

/** Whether a message is a continuation one of this offer's resume actions sent, read off its id. */
export function isRestartContinuationOf(
  marker: AgentSessionResumeMarker,
  clientMessageId: string
): boolean {
  return /^\d{13}-[0-9a-f]{32}$/.test(clientMessageId)
    ? clientMessageId.slice(14, 30) === restartOfferTag(marker)
    : false
}

/** The fence only fills the envelope: admission names this send by its operation id, not a fence. */
export function restartContinuationEnvelope(
  sessionId: string,
  fence: number,
  marker: AgentSessionResumeMarker,
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
