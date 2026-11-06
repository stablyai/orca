import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isWriteFailureSubmission } from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import type { QueuedMessageRow } from './queued-message-table'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlValueLocation } from './journal-sql-value-codec'
import type { JournalInputCard, JournalInputEntry } from './journal-input-lineage'
import type { JournalInputSource } from './journal-input-source-schema'

export function writeJournalSqlInputEntityColumns(
  scope: JournalSqlScope,
  location: JournalSqlValueLocation,
  value: unknown
): void {
  if (value === undefined) {
    return
  }
  const key = [...scope.prefix, String(JSON.parse(location.key)), location.incarnation]
  if (location.collection === 'submissions') {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the submission map owns these payloads.
    const send = value as AgentJournalSubmission
    scope.db
      .prepare(`UPDATE journal_proj_submissions SET item_key=?, fingerprint=?, submitted_seq=?,
          submitted_at=?, accepted_seq=?, fence=?, dispatch_state=?, write_failure=?, recovered=?, queued_message_id=?
          WHERE session_id=? AND epoch=? AND client_message_id=? AND incarnation=?`)
      .run(
        JSON.stringify(agentJournalSubmissionKey(send.clientMessageId)),
        send.payloadFingerprint,
        send.submittedSequence ?? null,
        send.submittedAt,
        send.acceptedSequence ?? null,
        send.fence,
        send.dispatchState,
        Number(isWriteFailureSubmission(send)),
        Number(!!send.recovered),
        send.queuedMessageId ?? null,
        ...key
      )
  } else if (location.collection === 'receipts') {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the receipt map owns these payloads.
    const receipt = value as AgentJournalAcceptanceReceipt
    scope.db
      .prepare(`UPDATE journal_proj_receipts SET provider_item_id=?, cursor_epoch=?, cursor_seq=?, accepted_at=?
          WHERE session_id=? AND epoch=? AND client_message_id=? AND incarnation=?`)
      .run(
        receipt.providerItemId,
        receipt.cursor.epoch,
        receipt.cursor.sequence,
        receipt.acceptedAt,
        ...key
      )
  } else if (location.collection === 'queue.cards') {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the queue card map owns these payloads.
    const card = value as QueuedMessageRow
    scope.db
      .prepare(`UPDATE journal_proj_queue_cards SET position=?, state=?, hold_reason=?, consumed_as=?,
          queued_epoch=?, queued_seq=? WHERE session_id=? AND epoch=? AND message_id=? AND incarnation=?`)
      .run(
        card.position,
        card.state,
        card.holdReason,
        card.consumedAs,
        card.queuedAt?.epoch ?? null,
        card.queuedAt?.sequence ?? null,
        ...key
      )
  } else if (location.collection === 'inputEntries') {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the input entry map owns these payloads.
    const entry = value as JournalInputEntry
    scope.db
      .prepare(`UPDATE journal_proj_input_entries SET basis=?, source_epoch=?, source_seq=?, cut=?
          WHERE session_id=? AND epoch=? AND input_id=? AND incarnation=?`)
      .run(
        entry.context.basis,
        entry.context.source.epoch,
        entry.context.source.sequence,
        entry.context.cut,
        ...key
      )
  } else if (location.collection === 'inputCards') {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lineage card map owns these payloads.
    const card = value as JournalInputCard
    const baseline = card.baseline
    scope.db
      .prepare(`UPDATE journal_proj_lineage_cards SET introduced=?, baseline_kind=?, baseline_epoch=?, baseline_seq=?
          WHERE session_id=? AND epoch=? AND message_id=? AND incarnation=?`)
      .run(
        card.introduced,
        baseline === undefined ? 'absent' : baseline.coordinate === null ? 'null' : 'coordinate',
        baseline?.coordinate?.epoch ?? null,
        baseline?.coordinate?.sequence ?? null,
        ...key
      )
  } else if (location.collection === 'inputs.sources') {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the input source map owns these payloads.
    const source = value as JournalInputSource
    scope.db
      .prepare(`UPDATE journal_proj_input_sources SET kind=?, source_epoch=?, source_seq=?, fence=?
          WHERE session_id=? AND epoch=? AND input_id=? AND incarnation=?`)
      .run(
        source.kind,
        source.epoch,
        source.kind === 'submission' ? source.seq : source.sequence,
        source.fence,
        ...key
      )
  }
}
