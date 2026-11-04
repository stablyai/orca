import type { JournalRow } from './journal-row-schema'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { latestAgentSessionContextClearSequence } from '../../../shared/agent-session/agent-session-context-clear'
import { isWriteFailureSubmission } from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { journalItemDeclaresEcho, type JournalItemEcho } from './journal-item-echo'
import type { JournalReducerState } from './journal-reducer'

export function resolveJournalItemId(
  state: JournalReducerState,
  itemId: string,
  body?: AgentJournalRenderItem['body']
): string {
  const addressed = journalItemAddress(state, itemId, body)
  rememberJournalItemAlias(state, itemId, addressed)
  return addressed
}

export function journalItemAddress(
  state: JournalReducerState,
  itemId: string,
  body?: AgentJournalRenderItem['body'],
  incoming: JournalItemEcho = {}
): string {
  return (
    state.aliases.get(itemId) ??
    (journalItemDeclaresEcho(state.itemEchoes, itemId, incoming)
      ? null
      : journalEchoClaimant(state, itemId, body)) ??
    itemId
  )
}

export function rememberJournalItemAlias(
  state: JournalReducerState,
  itemId: string,
  addressed: string
): void {
  if (addressed === itemId || state.aliases.has(itemId)) {
    return
  }
  state.aliases.set(itemId, addressed)
  state.derivedTurnScope.cancellations.rememberAlias(itemId, addressed)
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
  const contextSequence = latestAgentSessionContextClearSequence(state.items.values())
  // Match equal payloads in send order; proven-undelivered legacy rows cannot claim later resend echoes.
  const submission = [...state.submissions.values()]
    .sort((left, right) => left.submittedAt - right.submittedAt)
    .find(
      (candidate) =>
        (contextSequence === 0 || (candidate.acceptedSequence ?? 0) > contextSequence) &&
        candidate.dispatchState !== 'rejected' &&
        !isWriteFailureSubmission(candidate) &&
        candidate.payloadFingerprint === fingerprint &&
        state.items.get(agentJournalSubmissionKey(candidate.clientMessageId))?.revision === 0
    )
  return submission ? agentJournalSubmissionKey(submission.clientMessageId) : null
}

export function journalChangedItemIds(state: JournalReducerState, row: JournalRow): string[] {
  const changes =
    row.kind === 'item' || row.kind === 'tombstone'
      ? [row]
      : row.kind === 'lifecycle-batch'
        ? row.mutations
        : []
  return changes.map((change) =>
    (change.kind === 'item' && change.executionOrigin) ||
    (change.kind === 'tombstone' && state.tombstones.has(change.itemId))
      ? change.itemId
      : (state.aliases.get(change.itemId) ?? change.itemId)
  )
}
