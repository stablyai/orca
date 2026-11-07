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
import type {
  CommandReceipt,
  CommandReceiptResult,
  CommandReceiptScope
} from './writing/command-receipt-schema'
import { promptAnswerReceipt, promptRowAnswer } from './writing/command-receipt-prompt-answer'
import { insertCommandReceiptIfAbsent } from './writing/command-receipt-table'
import { CommandReceiptExistsError } from './writing/command-receipt-transaction'
import type { JournalRow } from './durable-rows/journal-row-schema'

export type JournalWriterEffect =
  | { kind: 'store'; writes: AgentSessionStoreRowWrites; insertOperationsIfAbsent: boolean }
  | {
      kind: 'receipt'
      scope: CommandReceiptScope
      receipt: CommandReceipt
      /** Derive an accepted answer from the row assigned inside this transaction. */
      row?: JournalReceiptRowBinding
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

export type JournalReceiptRowBinding = {
  at: 'first' | 'last'
  /** Kinds the row may have; any other row, or none, fails the command unless `absent` answers. */
  kinds?: readonly JournalRow['kind'][]
  answer: 'journal-row' | 'prompt-answer'
  absent?: CommandReceiptResult
}

export type JournalWriterEffectResult =
  | { referenced: Set<string>; inserted: string[] }
  | { receipt: CommandReceipt; row: JournalRow['kind'] | null }
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
      const row = effect.row && (effect.row.at === 'first' ? rows[0] : rows.at(-1))
      const receipt = effect.row ? boundReceipt(effect.receipt, effect.row, row) : effect.receipt
      const result = insertCommandReceiptIfAbsent(db, effect.scope, receipt)
      if (!result.inserted) {
        throw new CommandReceiptExistsError(result)
      }
      return { receipt, row: row?.kind ?? null }
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

function boundReceipt(
  receipt: CommandReceipt,
  binding: JournalReceiptRowBinding,
  row: JournalRow | undefined
): CommandReceipt {
  if (receipt.status !== 'accepted') {
    throw new Error('only an accepted receipt binds its row')
  }
  if (!row || (binding.kinds && !binding.kinds.includes(row.kind))) {
    if (binding.absent) {
      return { ...receipt, result: binding.absent }
    }
    throw new Error(`an accepted command requires its ${binding.kinds?.join(' or ') ?? ''} row`)
  }
  return {
    ...receipt,
    result:
      binding.answer === 'prompt-answer'
        ? promptAnswerReceipt(promptRowAnswer(row))
        : { kind: 'journal-row', epoch: row.epoch, sequence: row.seq }
  }
}
