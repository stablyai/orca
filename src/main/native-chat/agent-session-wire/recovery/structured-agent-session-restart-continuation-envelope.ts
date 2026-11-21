import { createHash } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalRestartOf } from '../../../../shared/agent-session/journal/agent-journal-bot-message-fields'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import { restartContinuationMessage } from '../../../../shared/agent-session/lifecycle/stopping/agent-session-restart-continuation'
import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import type { AgentSessionMutationEnvelope } from '../../../../shared/agent-session/agent-session-wire'
import { agentSessionSendFields } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'

/** What a continuation is sent for: the offer's wording, and the interrupted work it resumes (a
 *  restart offer's `work`, or a cut turn's row named outright). */
export type RestartContinuationSource = Pick<AgentSessionResumeMarker, 'activity'> & {
  work?: AgentSessionResumeMarker['work']
  restartOf?: AgentJournalRestartOf
}

/** The work a continuation resumes, written on it so the requests that work answered are answered
 *  by the continuation (design: slack-reply-lost-restart). */
export function restartContinuationOf(
  source: RestartContinuationSource
): AgentJournalRestartOf | undefined {
  return source.restartOf ?? (source.work && { kind: source.work.kind, id: source.work.id })
}

export function restartContinuationBody(
  source: RestartContinuationSource
): AgentJournalMessageItem {
  const restartOf = restartContinuationOf(source)
  return {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: restartContinuationMessage(source) }],
    ...(restartOf ? { restartOf } : {})
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
  marker: RestartContinuationSource,
  continuationId: string
): { envelope: AgentSessionMutationEnvelope; body: AgentJournalMessageItem } {
  const body = restartContinuationBody(marker)
  return {
    body,
    envelope: {
      sessionId,
      clientOperationId: continuationId,
      expectedRuntimeFence: fence,
      // Over the fields the host's send plan hashes, which leave out restartOf: the same request
      // must hash the same on both sides, or the host refuses it as a mismatch.
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId,
        fields: agentSessionSendFields({ body })
      })
    }
  }
}
