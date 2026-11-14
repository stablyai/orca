import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { dispatchWasWithdrawn } from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalSqlScope } from './journal-sql-scope'
import type {
  JournalMailAttempt,
  JournalMailObservation,
  StructuredSendAnswer
} from './journal-mail-observation'
import { journalDomainQueueRow } from './journal-domain-queue-rows'
import { journalDomainSubmission } from './journal-domain-status-inputs'
import { journalDomainLinkedInputs } from './journal-domain-input-populations'
import { readJournalSqlInput } from './journal-sql-input-reads'
import { readJournalDomainQueueHead } from './journal-domain-queue-reads'
import { readCommandReceipt } from './writing/command-receipt-table'
import { readMailWithdrawal } from './writing/mail-withdrawal-receipts'
import { isAdmissibleAgentJournalMessageBody } from '../../../shared/agent-session/journal/agent-session-journal-schemas'
import {
  orchestrationMailNotice,
  readAgentMessageSource
} from '../../../shared/agent-session/agent-session-message-source'

/** Outcome, immutable accepted source and deletion cause share the reader's one WAL snapshot. */
export function readJournalDomainMailObservation(
  scope: JournalSqlScope,
  attempt: JournalMailAttempt
): JournalMailObservation {
  if (attempt.session_id !== scope.sessionId) {
    throw new Error('mail observation targets another session')
  }
  const card = journalDomainQueueRow(scope.db, scope, attempt.operation_id)?.card
  let submission = card?.consumedAs
    ? journalDomainSubmission(scope, card.consumedAs)
    : journalDomainSubmission(scope, attempt.operation_id)
  if (!card && !submission) {
    for (const linked of journalDomainLinkedInputs(scope, attempt.operation_id)) {
      if (
        linked.queuedMessageId === attempt.operation_id &&
        (!submission || (linked.submittedSequence ?? 0) >= (submission.submittedSequence ?? 0))
      ) {
        submission = linked
      }
    }
  }
  const answer = (): StructuredSendAnswer => {
    if (card?.state === 'withdrawn') {
      return { kind: 'withdrawn' }
    }
    if (card && card.state !== 'dispatched') {
      return { kind: 'waiting' }
    }
    if (submission) {
      if (
        submission.queuedMessageId !== undefined &&
        submission.queuedMessageId !== attempt.operation_id
      ) {
        return { kind: 'unknown' }
      }
      if (card?.consumedAs && submission.queuedMessageId !== attempt.operation_id) {
        return { kind: 'unknown' }
      }
      if (submission.dispatchState === 'accepted') {
        return { kind: 'accepted' }
      }
      if (submission.dispatchState === 'pending') {
        return { kind: 'waiting' }
      }
      if (submission.dispatchState === 'unknown') {
        return { kind: 'unknown' }
      }
      if (submission.queuedMessageId !== undefined) {
        return { kind: card ? 'waiting' : 'withdrawn' }
      }
      const row = scope.db
        .prepare(`SELECT sequence FROM journal_items
        WHERE session_id=? AND epoch=? AND item_id=?`)
        .get(...scope.prefix, agentJournalSubmissionKey(submission.clientMessageId))
      const accepted = readJournalSqlInput(scope, { kind: 'latest-accepted-handover' })
      const at = row ? Number(row.sequence) : undefined
      return {
        kind: 'rejected',
        cancelled: dispatchWasWithdrawn(submission),
        recovered:
          at !== undefined &&
          ((accepted.kind === 'latest-accepted-handover' && accepted.sequence > at) ||
            readJournalDomainQueueHead(scope.db, scope).clearedThrough > at)
      }
    }
    if (card) {
      return { kind: 'unknown' }
    }
    const receipt = readCommandReceipt(scope.db, { kind: 'global' }, attempt.operation_id)
    if (receipt.verdict === 'absent') {
      return { kind: 'absent' }
    }
    if (receipt.verdict === 'unreadable') {
      return { kind: 'unreadable' }
    }
    return receipt.receipt.status === 'rejected' && receipt.receipt.sessionId === scope.sessionId
      ? { kind: 'refused' }
      : { kind: 'unknown' }
  }
  let state = answer()
  let body: AgentJournalMessageItem | null = null
  if (state.kind === 'accepted' && submission) {
    const row = scope.db
      .prepare(`SELECT admission_body_json FROM journal_submission_attempts
      WHERE session_id=? AND epoch=? AND message_id=? AND current=1 AND submitted_sequence=?`)
      .get(...scope.prefix, submission.clientMessageId, submission.submittedSequence ?? -1)
    if (row?.admission_body_json) {
      const candidate = scope.decode<unknown>(row.admission_body_json)
      if (isAdmissibleAgentJournalMessageBody(candidate)) {
        body = candidate
      }
    }
  }
  const source = card && orchestrationMailNotice(readAgentMessageSource(card.body.from))
  const matchesCard =
    !card ||
    (source?.mailbox === attempt.mailbox_handle &&
      source.messages.filter((member) => member.messageId === attempt.message_id).length === 1)
  const cause =
    state.kind === 'withdrawn' || (!card && !submission)
      ? readMailWithdrawal(scope.db, attempt, scope.epoch)
      : 'unknown'
  // Personal edits strip provenance; an exact successful person-delete receipt still owns deletion.
  const withdrawal = cause === 'person' || matchesCard ? cause : 'unknown'
  // Successful exact-target deletion receipts survive queue tombstone pruning.
  if (!card && !submission && withdrawal !== 'unknown') {
    state = { kind: 'withdrawn' }
  }
  return {
    epoch: scope.epoch,
    state,
    body,
    withdrawal
  }
}
