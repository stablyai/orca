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

/** One resume action's continuation: the same action sends it once, and a retry is a new action
 *  with a new message, never a replay of the one that failed. Dated by the action, not the quit:
 *  the ledger refuses a new id dated more than a day back, and an offer has no expiry. */
export function restartContinuationId(
  sessionId: string,
  marker: AgentSessionResumeMarker,
  operationId: string,
  actionAt: number
): string {
  return `${Math.trunc(actionAt).toString().padStart(13, '0')}-${createHash('sha256')
    .update(
      JSON.stringify([
        marker.teardownId,
        sessionId,
        marker.work.kind,
        marker.work.id,
        marker.providerHandleRoot,
        operationId
      ])
    )
    .digest('hex')
    .slice(0, 32)}`
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
