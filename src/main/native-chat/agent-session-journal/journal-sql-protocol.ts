import type { JournalUnitPacket, JournalResultPacket } from './journal-unit-transfer'
import type { JournalMaintenanceUnit, JournalMaintenanceResult } from './journal-maintenance-unit'
import {
  AgentSessionRefusalError,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionExpiredAttachment } from '../../../shared/agent-session/failures/agent-session-expired-attachments'
import type { SQLInputValue } from 'node:sqlite'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { JournalEffectResult } from './journal-persistence-plan'
import type { JournalOutcomeSource } from './journal-outcome-format'
import type { CommandReceiptScope } from './command-receipt-schema'
import type { CommandReceiptRead } from './command-receipt-table'
import { AgentSessionJournalError } from './journal-write-guards'
import { JournalUnreleasedSchemaError, JournalDamageError } from './journal-open-failure'
import { JournalOutcomeDecodeError } from './journal-outcome-codec'
import { CommandReceiptExistsError } from './command-receipt-transaction'
import { AgentSessionAttachmentExpiredError } from '../agent-session-attachments/agent-session-attachment-claims'

export type JournalRead =
  | { kind: 'sql'; sql: string; parameters: SQLInputValue[]; one: boolean }
  | { kind: 'page'; token: number }
  | { kind: 'release'; token: number }
  | { kind: 'source'; sessionId: string; epoch: string }
  | { kind: 'receipts'; scope: CommandReceiptScope; ids: string[] }
  | { kind: 'probe' }
  | { kind: 'outcomes'; generation: number; through: number; field: string; key: string }
export type JournalReadResult =
  | { kind: 'rows'; rows: SqliteRow[]; token?: number }
  | { kind: 'source'; source: JournalOutcomeSource | null }
  | { kind: 'receipts'; receipts: CommandReceiptRead[] }
  | { kind: 'probe'; present: boolean }
export type JournalSqlCommand =
  | { type: 'read'; read: JournalRead }
  | { type: 'upload'; packets: JournalUnitPacket[] }
  | { type: 'discard' }
  | { type: 'unit'; normal: boolean; count: number }
  | { type: 'maintenance'; unit: JournalMaintenanceUnit }
  | { type: 'snapshot'; open: boolean }
  | { type: 'close' }
export type JournalSqlFailure = {
  name: string
  message: string
  code?: string
  errcode?: number
  receipt?: CommandReceiptExistsError['result']
  refusal?: AgentSessionWireRefusal
  expired?: readonly AgentSessionExpiredAttachment[]
}
export type JournalSqlResponse =
  | { type: 'ready'; readOnly: boolean }
  | { type: 'read'; id: number; result: JournalReadResult }
  | {
      type: 'results'
      id: number
      packets: JournalResultPacket[]
    }
  | { type: 'committed'; id: number; values: JournalEffectResult[]; postcommit?: JournalSqlFailure }
  | ({ type: 'maintained'; id: number; postcommit?: JournalSqlFailure } & JournalMaintenanceResult)
  | { type: 'done'; id: number }
  | {
      type: 'failed'
      id?: number
      fatal?: boolean
      outcome: 'not-dispatched' | 'not-committed' | 'rolled-back' | 'indeterminate'
      error: JournalSqlFailure
    }
export type JournalSqlRequest = { id: number; command: JournalSqlCommand }

export function journalSqlFailure(error: unknown): JournalSqlFailure {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    code:
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined,
    errcode:
      error instanceof Error && 'errcode' in error && typeof error.errcode === 'number'
        ? error.errcode
        : undefined,
    refusal: error instanceof AgentSessionRefusalError ? error.refusal : undefined,
    expired: error instanceof AgentSessionAttachmentExpiredError ? error.expired : undefined,
    receipt: error instanceof CommandReceiptExistsError ? error.result : undefined
  }
}
export function restoreJournalSqlFailure(error: JournalSqlFailure): Error {
  if (error.refusal) {
    return new AgentSessionRefusalError(error.refusal)
  }
  if (error.receipt) {
    return new CommandReceiptExistsError(error.receipt)
  }
  switch (error.name) {
    case 'JournalUnreleasedSchemaError':
      return new JournalUnreleasedSchemaError(error.message)
    case 'JournalDamageError':
      return new JournalDamageError(error.message)
    case 'JournalOutcomeDecodeError':
      return new JournalOutcomeDecodeError(error.message)
    case 'AgentSessionAttachmentExpiredError':
      return new AgentSessionAttachmentExpiredError(error.expired ?? [])
    case 'AgentSessionJournalError': {
      const code = error.code
      if (
        code === 'journal_read_only' ||
        code === 'journal_stale_fence' ||
        code === 'journal_closed' ||
        code === 'journal_submission_exists' ||
        code === 'journal_row_rejected'
      ) {
        return new AgentSessionJournalError(code, error.message)
      }
    }
  }
  return Object.assign(new Error(error.message), error)
}
