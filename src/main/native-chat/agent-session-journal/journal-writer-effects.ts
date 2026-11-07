import type Database from '../../sqlite/sync-database'
import type { AgentSessionStoreRowWrites } from '../../runtime/agent-session/records/agent-session-store-draft'
import {
  insertAgentSessionOperationRowsIfAbsent,
  writeAgentSessionStoreRows
} from '../../runtime/agent-session/records/agent-session-record-rows'
import {
  claimAgentSessionAttachmentsInTransaction,
  finishUploadSweep,
  markUnclaimedUploadForSweep,
  type AgentSessionAttachmentClaim
} from '../agent-session-attachments/agent-session-attachment-claims'
import type { CommandReceipt, CommandReceiptScope } from './writing/command-receipt-schema'
import { insertCommandReceiptIfAbsent } from './writing/command-receipt-table'
import { CommandReceiptExistsError } from './writing/command-receipt-transaction'
import type { JournalRow } from './durable-rows/journal-row-schema'

export type JournalWriterEffect =
  | { kind: 'store'; writes: AgentSessionStoreRowWrites; insertOperationsIfAbsent: boolean }
  | {
      kind: 'receipt'
      scope: CommandReceiptScope
      receipt: CommandReceipt
      /** Bind an accepted journal-row answer to the row assigned inside this transaction. */
      row?: 'first' | 'last'
    }
  | { kind: 'claim'; claim: Omit<AgentSessionAttachmentClaim, 'stateDirectory'> }
  | { kind: 'queue-delete'; sessionId: string; messageIds: readonly string[] }
  | {
      kind: 'sweep'
      operation:
        | { kind: 'mark'; uploadId: string; now: number }
        | { kind: 'finish'; uploadId: string }
        | { kind: 'prune'; pairs: readonly { uploadId: string; sessionId: string }[] }
    }

export type JournalWriterEffectResult =
  | { referenced: Set<string>; inserted: string[] }
  | boolean
  | number
  | null

/** Host-computed values still recheck uniqueness and sweep authority on the sole connection. */
export function applyJournalWriterEffect(
  db: Database.Database,
  stateDirectory: string,
  effect: JournalWriterEffect,
  rows: readonly JournalRow[] = []
): JournalWriterEffectResult {
  switch (effect.kind) {
    case 'store': {
      const { writes } = effect
      if (effect.insertOperationsIfAbsent) {
        insertAgentSessionOperationRowsIfAbsent(db, writes.operations.upsert)
      }
      writeAgentSessionStoreRows(
        db,
        effect.insertOperationsIfAbsent
          ? { ...writes, operations: { ...writes.operations, upsert: [] } }
          : writes
      )
      return null
    }
    case 'receipt': {
      let receipt = effect.receipt
      if (effect.row) {
        const row = effect.row === 'first' ? rows[0] : rows.at(-1)
        if (!row || receipt.status !== 'accepted' || receipt.result.kind !== 'journal-row') {
          throw new Error('journal receipt has no assigned row')
        }
        receipt = {
          ...receipt,
          result: { kind: 'journal-row', epoch: row.epoch, sequence: row.seq }
        }
      }
      const result = insertCommandReceiptIfAbsent(db, effect.scope, receipt)
      if (!result.inserted) {
        throw new CommandReceiptExistsError(result)
      }
      return null
    }
    case 'claim':
      return claimAgentSessionAttachmentsInTransaction(db, { ...effect.claim, stateDirectory })
    case 'queue-delete': {
      const remove = db.prepare('DELETE FROM queued_messages WHERE session_id=? AND message_id=?')
      for (const messageId of effect.messageIds) {
        remove.run(effect.sessionId, messageId)
      }
      return null
    }
    case 'sweep': {
      const operation = effect.operation
      if (operation.kind === 'mark') {
        return markUnclaimedUploadForSweep(db, operation.uploadId, operation.now)
      }
      if (operation.kind === 'finish') {
        finishUploadSweep(db, operation.uploadId)
        return null
      }
      const remove = db.prepare(
        'DELETE FROM agent_session_attachment_claims WHERE upload_id=? AND session_id=?'
      )
      let removed = 0
      for (const pair of operation.pairs) {
        removed += Number(remove.run(pair.uploadId, pair.sessionId).changes)
      }
      return removed
    }
  }
}
