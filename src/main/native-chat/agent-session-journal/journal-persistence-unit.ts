import { journalTable, type JournalTableScope } from './journal-table-scope'
import type Database from '../../sqlite/sync-database'
import type { JournalPersistenceEffect, JournalEffectResult } from './journal-persistence-plan'
import {
  insertAgentSessionOperationRowsIfAbsent,
  writeAgentSessionStoreRows
} from '../../runtime/agent-session/records/agent-session-record-rows'
import { insertCommandReceiptIfAbsent } from './command-receipt-table'
import { CommandReceiptExistsError } from './command-receipt-transaction'
import {
  markUnclaimedUploadForSweep,
  finishUploadSweep,
  claimPreparedAgentSessionAttachments
} from '../agent-session-attachments/agent-session-attachment-claims'
import { journalOutcomeSource } from './journal-outcome-format'
import {
  readJournalSessionEpoch,
  deleteJournalEpochRows,
  publishJournalSessionEpoch
} from './journal-row-table'
import { applyJournalOutcomeAppend } from './journal-outcome-append'
import { AgentSessionJournalError } from './journal-write-guards'

/** Result-dependent SQL stays on the native owner, including earlier writes in this same unit. */
export function applyJournalPersistenceEffect(
  db: Database.Database,
  effect: JournalPersistenceEffect,
  tableScope: JournalTableScope = 'main'
): JournalEffectResult {
  switch (effect.kind) {
    case 'rows': {
      const insert = db.prepare(
        `INSERT INTO ${journalTable(tableScope, 'journal_rows')} (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)`
      )
      for (const row of effect.rows) {
        insert.run(effect.sessionId, row.epoch, row.seq, row.savedAt, row.json)
      }
      return null
    }
    case 'queue-delete': {
      const remove = db.prepare(
        `DELETE FROM ${journalTable(tableScope, 'queued_messages')} WHERE session_id = ? AND message_id = ?`
      )
      for (const id of effect.ids) {
        remove.run(effect.sessionId, id)
      }
      return null
    }
    case 'store': {
      const { writes } = effect
      if (effect.insertOperationsIfAbsent) {
        insertAgentSessionOperationRowsIfAbsent(db, writes.operations.upsert, tableScope)
      }
      writeAgentSessionStoreRows(
        db,
        effect.insertOperationsIfAbsent
          ? { ...writes, operations: { ...writes.operations, upsert: [] } }
          : writes,
        tableScope
      )
      return null
    }
    case 'receipt': {
      const result = insertCommandReceiptIfAbsent(db, effect.scope, effect.receipt, tableScope)
      if (!result.inserted) {
        throw new CommandReceiptExistsError(result)
      }
      return null
    }
    case 'claim':
      return claimPreparedAgentSessionAttachments(db, effect.claim, tableScope)
    case 'sweep': {
      const op = effect.operation
      if (op.kind === 'mark') {
        return markUnclaimedUploadForSweep(db, op.uploadId, op.now, tableScope)
      }
      if (op.kind === 'finish') {
        finishUploadSweep(db, op.uploadId, tableScope)
        return null
      }
      const remove = db.prepare(
        `DELETE FROM ${journalTable(tableScope, 'agent_session_attachment_claims')} WHERE upload_id = ? AND session_id = ?`
      )
      let removed = 0
      for (const pair of op.pairs) {
        removed += Number(remove.run(pair.uploadId, pair.sessionId).changes)
      }
      return removed
    }
    case 'epoch': {
      const retired = readJournalSessionEpoch(db, effect.sessionId, tableScope)
      if (effect.expected !== undefined && retired !== effect.expected) {
        throw new AgentSessionJournalError('journal_row_rejected', 'the chat epoch changed')
      }
      if (retired !== null) {
        journalOutcomeSource(db, effect.sessionId, retired, tableScope)
        deleteJournalEpochRows(db, effect.sessionId, retired, tableScope)
      }
      publishJournalSessionEpoch(db, effect, effect.epoch, tableScope)
      return null
    }
    case 'outcomes': {
      applyJournalOutcomeAppend(db, { ...effect, expectedSequence: effect.expected }, tableScope)
      return null
    }
  }
}
