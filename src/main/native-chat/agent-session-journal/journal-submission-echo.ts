import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { isWriteFailureSubmission } from '../../../shared/structured-agent-session-dispatch-rejection'
import { latestAgentSessionContextClearSequence } from '../../../shared/agent-session-context-clear'
import { journalItemDeclaresEcho } from './journal-item-echo'
import type { JournalReducerState } from './journal-reducer'

export function resolveJournalItemId(
  state: JournalReducerState,
  itemId: string,
  body?: AgentJournalRenderItem['body']
): string {
  const aliased = state.aliases.get(itemId)
  if (aliased) {
    return aliased
  }
  const submissionId = journalEchoClaimant(state, itemId, body)
  if (!submissionId) {
    return itemId
  }
  state.aliases.set(itemId, submissionId)
  return submissionId
}

export function isProviderUserMessageEcho(
  itemId: string,
  body: AgentJournalRenderItem['body']
): boolean {
  const identity = parseAgentJournalItemKey(itemId)
  return (
    body.kind === 'message' &&
    body.role === 'user' &&
    identity !== null &&
    identity.provider !== 'orca'
  )
}

/** Find an echo's eligible submission without claiming it. */
export function journalEchoClaimant(
  state: JournalReducerState,
  itemId: string,
  body?: AgentJournalRenderItem['body']
): string | null {
  if (
    !body ||
    journalItemDeclaresEcho(state.itemEchoes, itemId) ||
    !isProviderUserMessageEcho(itemId, body)
  ) {
    return null
  }
  const fingerprint = agentSessionSendBodyFingerprint(state.sessionId, body)
  const contextSequence =
    state.sourceIdentity?.contextSequence ??
    latestAgentSessionContextClearSequence(state.items.values())
  // Match equal payloads in send order; proven-undelivered legacy rows cannot claim later resend echoes.
  const eligible = (candidate: AgentJournalSubmission) =>
    (contextSequence === 0 || (candidate.acceptedSequence ?? 0) > contextSequence) &&
    candidate.dispatchState !== 'rejected' &&
    !isWriteFailureSubmission(candidate) &&
    candidate.payloadFingerprint === fingerprint &&
    state.items.get(agentJournalSubmissionKey(candidate.clientMessageId))?.revision === 0
  const submission = state.sourceIdentity
    ? state.sourceIdentity.echoes.first(fingerprint, eligible)
    : [...state.submissions.values()]
        .sort((left, right) => left.submittedAt - right.submittedAt)
        .find(eligible)
  return submission ? agentJournalSubmissionKey(submission.clientMessageId) : null
}
