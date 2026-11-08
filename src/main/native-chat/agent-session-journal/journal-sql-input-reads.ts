import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  JournalInputRead,
  JournalInputReadResult,
  JournalInputSingleRead,
  JournalInputSingleReadResult
} from './journal-input-reads'
import type { JournalSqlScope } from './journal-sql-scope'
import {
  journalDomainInputCount,
  journalDomainInputForItem,
  journalDomainInputOrdinal,
  journalDomainRecoverableSubmissions
} from './journal-domain-status-inputs'
import {
  journalDomainAcceptedInputsAfter,
  journalDomainEnteredInputs,
  journalDomainFirstQueuedInput,
  journalDomainLinkedInputs,
  journalDomainNewestTurn,
  journalDomainSendingInputs,
  journalDomainUnsettledInputs
} from './journal-domain-input-populations'
import { journalDomainStoppedHistoryInputs } from './journal-domain-stopped-inputs'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'

/** Named current-row reads run synchronously inside the caller's ready physical-epoch snapshot. */
export function readJournalSqlInput(
  scope: JournalSqlScope,
  operation: JournalInputRead
): JournalInputReadResult {
  if (operation.kind === 'batch') {
    return {
      kind: 'batch',
      results: operation.reads.map((read) => readInput(scope, read))
    }
  }
  return readInput(scope, operation)
}

function readInput(
  scope: JournalSqlScope,
  operation: JournalInputSingleRead
): JournalInputSingleReadResult {
  switch (operation.kind) {
    case 'latest-submission': {
      const row = scope.db
        .prepare(`SELECT payload_json FROM journal_submission_attempts
        WHERE session_id=? AND epoch=? AND current=1 AND dispatch_fence=?
        ORDER BY submitted_at DESC,ordinal DESC LIMIT 1`)
        .get(...scope.prefix, operation.fence)
      return {
        kind: operation.kind,
        submission: row
          ? scope.decode<AgentJournalSubmission>(scope.examined(row).payload_json)
          : undefined
      }
    }
    case 'first-queued':
      return { kind: operation.kind, submission: journalDomainFirstQueuedInput(scope) }
    case 'entered-submissions':
      return { kind: operation.kind, submissions: [...journalDomainEnteredInputs(scope)] }
    case 'sending-submissions':
      return { kind: operation.kind, submissions: [...journalDomainSendingInputs(scope)] }
    case 'pending-submissions':
      return { kind: operation.kind, submissions: [...journalDomainUnsettledInputs(scope, true)] }
    case 'unsettled-submissions':
      return { kind: operation.kind, submissions: [...journalDomainUnsettledInputs(scope)] }
    case 'recoverable-submissions':
      return { kind: operation.kind, submissions: [...journalDomainRecoverableSubmissions(scope)] }
    case 'recovered-unknown-ids':
      return {
        kind: operation.kind,
        ids: [...journalDomainUnsettledInputs(scope)]
          .filter((send) => send.dispatchState === 'unknown' && send.recovered === true)
          .map((send) => send.clientMessageId)
      }
    case 'accepted-submissions':
      return {
        kind: operation.kind,
        submissions: [...journalDomainAcceptedInputsAfter(scope, -Infinity)],
        latestReceiptSequence: latestReceiptSequence(scope)
      }
    case 'accepted-inputs-after':
      return {
        kind: operation.kind,
        submissions: [...journalDomainAcceptedInputsAfter(scope, operation.sequence)]
      }
    case 'linked-to':
      return {
        kind: operation.kind,
        submissions: [...journalDomainLinkedInputs(scope, operation.messageId)]
      }
    case 'input-for-item':
      return {
        kind: operation.kind,
        submission: journalDomainInputForItem(scope, operation.itemId)
      }
    case 'input-ordinal':
      return {
        kind: operation.kind,
        ordinal: journalDomainInputOrdinal(scope, operation.clientMessageId)
      }
    case 'input-count':
      return { kind: operation.kind, count: journalDomainInputCount(scope) }
    case 'capture-keys':
      return {
        kind: operation.kind,
        keys: [...new Set([...operation.present, ...inputKeys(scope)])].sort()
      }
    case 'newest-turn':
      return { kind: operation.kind, turn: journalDomainNewestTurn(scope) }
    case 'submission-at': {
      const row = scope.db
        .prepare(`SELECT payload_json FROM journal_submission_attempts
        WHERE session_id=? AND epoch=? AND current=1 AND submitted_sequence=?
        ORDER BY ordinal DESC LIMIT 1`)
        .get(...scope.prefix, operation.sequence)
      return {
        kind: operation.kind,
        submission: row
          ? scope.decode<AgentJournalSubmission>(scope.examined(row).payload_json)
          : undefined
      }
    }
    case 'signed-out-at': {
      const row = scope.db
        .prepare(`SELECT 1 FROM journal_submission_attempts
        WHERE session_id=? AND epoch=? AND current=1 AND signed_out=1 AND dispatch_fence=? LIMIT 1`)
        .get(...scope.prefix, operation.fence)
      if (row) {
        scope.examined(row)
      }
      return { kind: operation.kind, answer: row !== undefined }
    }
    case 'sent-after':
    case 'accepted-after': {
      const row = scope.db
        .prepare(`SELECT 1 FROM journal_submission_attempts
        WHERE session_id=? AND epoch=? AND current=1 AND accepted_sequence IS NOT NULL
        ${operation.kind === 'sent-after' ? "AND dispatch_state<>'rejected'" : ''}
        AND accepted_sequence>? LIMIT 1`)
        .get(...scope.prefix, operation.sequence)
      if (row) {
        scope.examined(row)
      }
      return { kind: operation.kind, answer: row !== undefined }
    }
    case 'stopped-history-inputs':
      return {
        kind: operation.kind,
        submissions: journalDomainStoppedHistoryInputs(
          scope,
          operation.excluding,
          operation.afterSequence
        )
      }
    case 'latest-accepted-handover': {
      const row = scope.db
        .prepare(`SELECT accepted_handover_sequence FROM journal_chat_state
        WHERE session_id=? AND epoch=?`)
        .get(...scope.prefix)
      if (!row) {
        throw new Error('journal handover read targets a retired chat epoch')
      }
      return {
        kind: operation.kind,
        sequence: Number(scope.examined(row).accepted_handover_sequence)
      }
    }
  }
}

function* inputKeys(scope: JournalSqlScope) {
  let after = ''
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT message_id FROM journal_submission_attempts
      WHERE session_id=? AND epoch=? AND current=1 AND message_id>? ORDER BY message_id LIMIT 128`)
      .all(...scope.prefix, after)
    for (const row of rows) {
      scope.examined(row)
      yield agentJournalSubmissionKey(String(row.message_id))
    }
    const last = rows.at(-1)
    if (rows.length < 128 || !last) {
      return
    }
    after = String(last.message_id)
  }
}

function latestReceiptSequence(scope: JournalSqlScope): number {
  const row = scope.db
    .prepare(`SELECT receipt.cursor_sequence FROM journal_send_receipts receipt
    WHERE receipt.session_id=? AND receipt.epoch=? AND EXISTS(
      SELECT 1 FROM journal_submission_attempts attempt
      WHERE attempt.session_id=receipt.session_id AND attempt.epoch=receipt.epoch
        AND attempt.message_id=receipt.message_id AND attempt.current=1)
    ORDER BY receipt.cursor_sequence DESC,receipt.message_id DESC LIMIT 1`)
    .get(...scope.prefix)
  return row ? Number(scope.examined(row).cursor_sequence) : 0
}
