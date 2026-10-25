// Read saved journal failures, not notification events, so every host supplies the same display sentence and provider detail.

import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { readAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { StructuredAgentSessionRequestFailure } from '../../native-chat/agent-session-wire/structured-agent-session-request-failures'

export type ChatRequestError = {
  text: string
  /** The provider's own message, when it wrote one that differs from the sentence. */
  detail?: string
  /** The shared failure kind; absent on rows from hosts that predate typed failures. */
  kind?: string
}

/** Sender rejections already reach the sender; typing into a worker chat must not page its coordinator. */
const SENDER_OWN_REJECTION_KINDS: ReadonlySet<string> = new Set([
  'emptyMessage',
  'attachmentInvalid',
  'attachmentUnreadable',
  'commandUnavailable',
  'commandRefused',
  'queueFull'
])

export function isSenderOwnRejection(error: ChatRequestError | null): boolean {
  return error?.kind !== undefined && SENDER_OWN_REJECTION_KINDS.has(error.kind)
}

/** Null when rows are not yet written or an older host recorded no refusal reason. */
export function chatRequestError(
  snapshot: Pick<AgentJournalSnapshot, 'items' | 'submissions'>,
  request: Pick<StructuredAgentSessionRequestFailure, 'kind' | 'id'>
): ChatRequestError | null {
  if (request.kind === 'refused-send') {
    const submission = snapshot.submissions.find(
      (entry) =>
        entry.dispatchState === 'rejected' &&
        agentJournalSubmissionKey(entry.clientMessageId) === request.id
    )
    return submission?.reason
      ? withDetail(submission.reason, readAgentSessionFailureFact(submission.rejection))
      : null
  }
  const items = snapshot.items
  const start = items.findIndex(
    (item) =>
      isRootAgentJournalItem(item) &&
      item.itemId === request.id &&
      readAgentJournalTurn(item.body) !== null
  )
  if (start === -1) {
    return null
  }
  const turnItemId = items[start]?.itemId
  // Explicit scope survives a later turn; only unscoped legacy rows need its timeline span.
  const next = items.findIndex(
    (item, index) =>
      index > start && isRootAgentJournalItem(item) && readAgentJournalTurn(item.body) !== null
  )
  // A typed failure row, or a provider's own error frame, which carries the agent's sentence only.
  const row = items.findLast(
    (item, index) =>
      isRootAgentJournalItem(item) &&
      item.body.kind === 'status' &&
      (item.body.failure
        ? item.body.failure.kind !== 'providerRetrying'
        : item.body.tone === 'error') &&
      (item.turnScope
        ? item.turnScope.kind === 'turn' && item.turnScope.turnItemId === turnItemId
        : index > start && (next === -1 || index < next))
  )
  const rejection = snapshot.submissions.findLast(
    (entry) =>
      entry.dispatchState === 'rejected' &&
      entry.answeredInTurn?.turnItemId === turnItemId &&
      entry.answeredInTurn.via === 'start' &&
      entry.reason &&
      !isSenderOwnRejection(withDetail(entry.reason, readAgentSessionFailureFact(entry.rejection)))
  )
  const related = rejection?.reason
    ? withDetail(rejection.reason, readAgentSessionFailureFact(rejection.rejection))
    : null
  const error =
    row?.body.kind === 'status' && row.body.text
      ? withDetail(row.body.text, readAgentSessionFailureFact(row.body.failure))
      : related
  return error && related && !error.detail && related.text !== error.text
    ? { ...error, detail: related.detail ?? related.text }
    : error
}

function withDetail(
  text: string,
  fact: ReturnType<typeof readAgentSessionFailureFact>
): ChatRequestError {
  const detail = fact?.detail?.text
  return {
    text,
    ...(detail && detail !== text ? { detail } : {}),
    ...(fact ? { kind: fact.kind } : {})
  }
}
