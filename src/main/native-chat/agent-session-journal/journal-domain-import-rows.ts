import { insertJournalDomainImportedSubmission } from './journal-domain-import-submissions'
import { journalDomainItemReadColumns } from './journal-domain-item-read-columns'
import { journalDomainItemPlacement } from './journal-domain-item-placement'
import type Database from '../../sqlite/sync-database'
import { journalDomainHistoryMetadata } from './journal-domain-history-metadata'
import { insertJournalDomainQueueRow, journalDomainQueueRow } from './journal-domain-queue-rows'
import type { JournalDomainImportHeader, JournalDomainImportPage } from './journal-domain-import'
import { writeJournalDomainItemNames } from './journal-domain-item-names'

export type JournalDomainImportState =
  | { state: 'converting'; epoch: null }
  | { state: 'ready'; epoch: string }

/**
 * A chat's head row is its ready mark: once written, domain state wins and the frozen source is
 * never read again. An unready chat imports the original under the profile lock.
 */
export function journalDomainImportState(
  db: Database.Database,
  sessionId: string
): JournalDomainImportState {
  const ready = db.prepare('SELECT epoch FROM journal_chat_state WHERE session_id=?').get(sessionId)
  if (ready?.epoch !== null && ready?.epoch !== undefined) {
    return { state: 'ready', epoch: String(ready.epoch) }
  }
  return { state: 'converting', epoch: null }
}

/**
 * One page in the writer transaction. Rows keep their restored identities, so a restarted import
 * rewrites nothing it already inserted; a ready chat's rows are never touched from source.
 */
export function insertJournalDomainImportPage(
  db: Database.Database,
  target: Pick<JournalDomainImportHeader, 'sessionId' | 'epoch'>,
  page: JournalDomainImportPage
): boolean {
  if (!db.isTransaction) {
    throw new Error('journal domain import requires its writer transaction')
  }
  if (
    db
      .prepare('SELECT 1 FROM journal_chat_state WHERE session_id=? AND epoch IS NOT NULL')
      .get(target.sessionId)
  ) {
    return false
  }
  const prefix = [target.sessionId, target.epoch] as const
  switch (page.kind) {
    case 'items': {
      const insert =
        db.prepare(`INSERT INTO journal_items(session_id,epoch,item_id,ordinal,revision,
        sequence,sequence_index,owner_fence,execution_owner,payload_json,hidden,root,subagent_row,
        subagent_group_key,turn_marker,wire_bytes,turn_item_id,original_stop_note_json,
        queue_command_turn,queue_failed_outcome,queue_failed_at,queue_failure_witnessed_through,queue_failure_report_turn_item_id,
        placement_json,kind,message_role,turn_id,opener_item_id,context_clear,goal_transition,producer_agent_id,producer_parent_ref,producer_attempt,prompt,signed_out)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
      for (const {
        ordinal,
        ownerFence,
        executionOwner,
        hidden,
        item,
        turnItemId,
        originalStopNoteJson,
        queueCommandTurn,
        queueFailedOutcome,
        queueFailedAt,
        queueFailureWitnessedThrough,
        queueFailureReportTurnItemId
      } of page.rows) {
        const payload = JSON.stringify(item)
        const metadata = journalDomainHistoryMetadata(item, payload)
        const result = insert.run(
          ...prefix,
          item.itemId,
          ordinal,
          item.revision,
          item.sequence,
          item.sequenceIndex ?? 0,
          ownerFence,
          executionOwner,
          payload,
          Number(hidden),
          metadata.root,
          metadata.subagentRow,
          metadata.subagentGroupKey,
          metadata.turnMarker,
          metadata.wireBytes,
          turnItemId,
          originalStopNoteJson,
          Number(queueCommandTurn),
          Number(queueFailedOutcome),
          queueFailedAt,
          queueFailureWitnessedThrough,
          queueFailureReportTurnItemId,
          journalDomainItemPlacement(item),
          ...journalDomainItemReadColumns(item)
        )
        if (Number(result.changes) > 0) {
          writeJournalDomainItemNames(
            db,
            target,
            item,
            { ordinal, hidden },
            metadata.namedSubagentIds
          )
        }
      }
      break
    }
    case 'tombstones': {
      const insert =
        db.prepare(`INSERT INTO journal_item_tombstones(session_id,epoch,item_id,revision)
        VALUES(?,?,?,?) ON CONFLICT DO NOTHING`)
      for (const { itemId, revision } of page.rows) {
        insert.run(...prefix, itemId, revision)
      }
      break
    }
    case 'aliases': {
      const insert = db.prepare(`INSERT INTO journal_item_aliases(session_id,epoch,provider_item_id,
        item_id,echo_declared,echo_json) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
      for (const { providerItemId, itemId, echo } of page.rows) {
        insert.run(
          ...prefix,
          providerItemId,
          itemId,
          Number(echo !== undefined),
          echo ? JSON.stringify(echo.value ?? null) : null
        )
      }
      break
    }
    case 'attempts':
      for (const attempt of page.rows) {
        insertJournalDomainImportedSubmission(db, target, attempt)
      }
      break
    case 'receipts': {
      const insert =
        db.prepare(`INSERT INTO journal_send_receipts(session_id,epoch,message_id,payload_json)
        VALUES(?,?,?,?) ON CONFLICT DO NOTHING`)
      for (const receipt of page.rows) {
        insert.run(...prefix, receipt.clientMessageId, JSON.stringify(receipt))
      }
      break
    }
    case 'cards':
      for (const card of page.rows) {
        if (!journalDomainQueueRow(db, target, card.messageId)) {
          insertJournalDomainQueueRow(db, target, card)
        }
      }
      break
    case 'activity': {
      const insert =
        db.prepare(`INSERT INTO journal_provider_activity(session_id,epoch,fence,last_activity_at)
        VALUES(?,?,?,?) ON CONFLICT DO NOTHING`)
      for (const { fence, lastActivityAt } of page.rows) {
        insert.run(...prefix, fence, lastActivityAt)
      }
      break
    }
    case 'removed-turns': {
      const insert = db.prepare(`INSERT INTO journal_removed_turns(session_id,epoch,turn_id)
        VALUES(?,?,?) ON CONFLICT DO NOTHING`)
      for (const { turnId } of page.rows) {
        insert.run(...prefix, turnId)
      }
      break
    }
    case 'queue-clear-members': {
      const insert =
        db.prepare(`INSERT INTO journal_queue_clear_members(session_id,epoch,message_id)
        VALUES(?,?,?) ON CONFLICT DO NOTHING`)
      for (const { messageId } of page.rows) {
        insert.run(...prefix, messageId)
      }
      break
    }
  }
  return true
}

/**
 * Written after every page: the head marks the chat ready. No replay events exist for imported
 * history, so the retained boundary is the head and any older cursor takes a snapshot reset.
 */
export function finishJournalDomainImport(
  db: Database.Database,
  header: JournalDomainImportHeader
): string {
  if (!db.isTransaction) {
    throw new Error('journal domain import requires its writer transaction')
  }
  const { head } = header
  db.prepare(`INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,retained_sequence,
    highest_fence,context_boundary,last_activity_at,derived_turn_item_id,history_origin_json,queue_latest_stop_json,
    queue_manual_stop_json,queue_resumed_sequence,queue_reopened_sequence,queue_clear_sequence,
    queue_clear_operation_id,queue_clear_lifted,queue_failure_boundary) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET
      epoch=excluded.epoch,last_sequence=excluded.last_sequence,retained_sequence=excluded.retained_sequence,
      highest_fence=excluded.highest_fence,context_boundary=excluded.context_boundary,
      last_activity_at=excluded.last_activity_at,derived_turn_item_id=excluded.derived_turn_item_id,
      history_origin_json=excluded.history_origin_json,
      queue_latest_stop_json=excluded.queue_latest_stop_json,queue_manual_stop_json=excluded.queue_manual_stop_json,
      queue_resumed_sequence=excluded.queue_resumed_sequence,queue_reopened_sequence=excluded.queue_reopened_sequence,
      queue_clear_sequence=excluded.queue_clear_sequence,queue_clear_operation_id=excluded.queue_clear_operation_id,
      queue_clear_lifted=excluded.queue_clear_lifted,queue_failure_boundary=excluded.queue_failure_boundary
    WHERE journal_chat_state.epoch IS NULL`).run(
    header.workspaceId,
    header.sessionId,
    header.epoch,
    head.lastSequence,
    head.lastSequence,
    head.highestFence,
    head.contextBoundary,
    head.lastActivityAt,
    head.derivedTurnItemId,
    head.historyOrigin === null ? null : JSON.stringify(head.historyOrigin),
    head.queuePauseMarks.latestStop ? JSON.stringify(head.queuePauseMarks.latestStop) : null,
    head.queuePauseMarks.manualStop === undefined
      ? null
      : JSON.stringify(head.queuePauseMarks.manualStop),
    head.queuePauseMarks.resumedSequence,
    head.queuePauseMarks.reopenedSequence,
    head.queuePauseMarks.cleared?.sequence ?? null,
    head.queuePauseMarks.cleared?.operationId ?? null,
    Number(head.queuePauseMarks.cleared?.lifted ?? false),
    head.queueFailureBoundary
  )
  const state = journalDomainImportState(db, header.sessionId)
  if (state.state !== 'ready') {
    throw new Error('journal domain import did not publish its chat head')
  }
  return state.epoch
}
