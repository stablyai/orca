import { journalForkAttachmentHeld } from './journal-fork-stage-state'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import type Database from '../../sqlite/sync-database'
import {
  applyPRWatchStorage,
  type PRWatchEffect,
  type PRWatchEffectValues
} from '../../github/pr-watch/pr-watch-storage'
import type { AgentSessionStoreRowWrites } from './journal-writer-store-row-changes'
import type { AgentSessionStoreMutation } from '../../runtime/agent-session/records/agent-session-store-mutation'
import type { AgentSessionRuntimeFacts } from '../../runtime/agent-session/agent-session-runtime-attribution'
import { applyJournalWriterStoreEffect } from './journal-writer-store-effect'
import {
  claimAgentSessionAttachmentsInTransaction,
  finishUploadSweep,
  markUnclaimedUploadForSweep,
  pruneAgentSessionAttachmentClaims,
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
import type { AgentSessionPromptResult } from '../../../shared/agent-session/agent-session-wire'

export type JournalWriterCoordinate = {
  kind: JournalRow['kind']
  epoch: string
  seq: number
  promptAnswer?: AgentSessionPromptResult
  planApprovalMode?: 'default' | 'plan'
}

export type JournalWriterEffect =
  | { kind: 'pr-watch'; operation: PRWatchEffect }
  | {
      kind: 'store'
      mutation: {
        input: AgentSessionStoreMutation
        at?: number
        runtime?: AgentSessionRuntimeFacts
      }
    }
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
  answer: 'journal-row' | 'prompt-answer' | CommandReceiptResult
  absent?: CommandReceiptResult
}

export type JournalWriterEffectResult =
  | { prWatch: PRWatchEffectValues[PRWatchEffect['kind']] }
  | { referenced: Set<string>; inserted: string[] }
  | { receipt: CommandReceipt; row: JournalRow['kind'] | null }
  | boolean
  | number
  | null
  | JournalWriterStoreResult

export type JournalWriterStoreResult = {
  kind: 'store'
  disposition: 'applied' | 'noop'
  writes: AgentSessionStoreRowWrites
  value?: unknown
}

/** Host-computed values still recheck uniqueness and sweep authority on the sole connection. */
export function applyJournalWriterEffect(
  db: Database.Database,
  stateDirectory: string,
  effect: JournalWriterEffect,
  rows: readonly (JournalRow | JournalWriterCoordinate)[] = []
): JournalWriterEffectResult {
  switch (effect.kind) {
    case 'pr-watch':
      return { prWatch: applyPRWatchStorage(db, effect.operation) }
    case 'store':
      return applyJournalWriterStoreEffect(db, effect, rows)
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
      const held = db.prepare('SELECT 1 FROM agent_session_records WHERE session_id=?')
      return pruneAgentSessionAttachmentClaims(db, {
        root: agentSessionAttachmentStoreRoot(stateDirectory),
        recordedSessionIds: {
          has: (sessionId) =>
            journalForkAttachmentHeld(db, sessionId) || Boolean(held.get(sessionId))
        },
        pairs: operation.pairs
      })
    }
  }
}

function boundReceipt(
  receipt: CommandReceipt,
  binding: JournalReceiptRowBinding,
  row: JournalRow | JournalWriterCoordinate | undefined
): CommandReceipt {
  if (receipt.status !== 'accepted') {
    throw new Error('only an accepted receipt binds its row')
  }
  if (typeof binding.answer === 'object') {
    return { ...receipt, result: binding.answer }
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
        ? promptAnswerReceipt(
            'promptAnswer' in row && row.promptAnswer
              ? row.promptAnswer
              : promptRowAnswer('v' in row ? row : undefined)
          )
        : { kind: 'journal-row', epoch: row.epoch, sequence: row.seq }
  }
}
