import type Database from '../../sqlite/sync-database'
import { journalPragmaNumber } from './journal-database'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { assertJournalWritable } from './journal-write-guards'
import {
  commandReceiptSchema,
  commandReceiptScopeSchema,
  type CommandReceipt,
  type CommandReceiptScope
} from './command-receipt-schema'

export type CommandReceiptRead =
  | { verdict: 'absent' }
  | { verdict: 'readable'; receipt: CommandReceipt }
  | { verdict: 'unreadable'; scope: CommandReceiptScope; operationId: string }

export type ExistingCommandReceipt = Exclude<CommandReceiptRead, { verdict: 'absent' }>

export type CommandReceiptInsert =
  | { inserted: true }
  | {
      inserted: false
      reason: 'duplicate' | 'conflict'
      existing: Extract<CommandReceiptRead, { verdict: 'readable' }>
    }
  | {
      inserted: false
      reason: 'unreadable'
      existing: Extract<CommandReceiptRead, { verdict: 'unreadable' }>
    }

const SELECT_RECEIPT = `SELECT session_id, caller_key, method, fingerprint, status,
  result_json, rejection_json, accepted_at FROM agent_session_command_receipts`

type CommandReceiptCandidates =
  | { verdict: 'readable'; receipts: CommandReceipt[] }
  | Extract<CommandReceiptRead, { verdict: 'unreadable' }>

function parseReceiptJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : undefined
}

function readCommandReceiptCandidates(
  db: Database.Database,
  scope: CommandReceiptScope,
  operationId: string
): CommandReceiptCandidates {
  const unreadable: Extract<CommandReceiptRead, { verdict: 'unreadable' }> = {
    verdict: 'unreadable',
    scope,
    operationId
  }
  try {
    // A newer read-only database may not expose this table; that cannot authorize a retry.
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('agent_session_command_receipts')
    ) {
      return unreadable
    }
    const rows =
      scope.kind === 'caller'
        ? db
            .prepare(`${SELECT_RECEIPT} WHERE caller_key = ? AND operation_id = ?`)
            .all(scope.callerKey, operationId)
        : db.prepare(`${SELECT_RECEIPT} WHERE operation_id = ? ORDER BY rowid`).all(operationId)
    const receipts: CommandReceipt[] = []
    for (const row of rows) {
      if (
        (row.status === 'accepted' && row.rejection_json !== null) ||
        (row.status === 'rejected' && row.result_json !== null)
      ) {
        return unreadable
      }
      const parsed = commandReceiptSchema.safeParse({
        operationId,
        sessionId: row.session_id,
        callerKey: row.caller_key,
        method: row.method,
        fingerprint: row.fingerprint,
        status: row.status,
        acceptedAt: row.accepted_at,
        ...(row.status === 'accepted'
          ? { result: parseReceiptJson(row.result_json) }
          : { rejection: parseReceiptJson(row.rejection_json) })
      })
      if (!parsed.success) {
        return unreadable
      }
      receipts.push(parsed.data)
    }
    return { verdict: 'readable', receipts }
  } catch (error) {
    if (
      error instanceof RangeError ||
      error instanceof SyntaxError ||
      (error instanceof Error &&
        'code' in error &&
        error.code === 'ERR_SQLITE_ERROR' &&
        /^no such (?:column|table):/.test(error.message))
    ) {
      return unreadable
    }
    throw error
  }
}

export function readCommandReceipt(
  db: Database.Database,
  scope: CommandReceiptScope,
  operationId: string
): CommandReceiptRead {
  const candidates = readCommandReceiptCandidates(db, scope, operationId)
  if (candidates.verdict === 'unreadable') {
    return candidates
  }
  const receipt = candidates.receipts[0]
  return receipt ? { verdict: 'readable', receipt } : { verdict: 'absent' }
}

/** The caller owns the effect's transaction; this function never reserves or commits on its own. */
export function insertCommandReceiptIfAbsent(
  db: Database.Database,
  scope: CommandReceiptScope,
  receipt: CommandReceipt
): CommandReceiptInsert {
  assertJournalWritable(
    journalPragmaNumber(db, 'user_version') > JOURNAL_DB_SCHEMA_VERSION,
    receipt.sessionId
  )
  if (!db.isTransaction) {
    throw new Error('a command receipt must be written inside an open transaction')
  }
  const written = commandReceiptSchema.parse(receipt)
  const claim = commandReceiptScopeSchema.parse(scope)
  if (claim.kind === 'caller' && claim.callerKey !== written.callerKey) {
    throw new Error('command caller does not match its scope')
  }
  const candidates = readCommandReceiptCandidates(db, claim, written.operationId)
  if (candidates.verdict === 'unreadable') {
    return { inserted: false, reason: 'unreadable', existing: candidates }
  }
  const duplicate = candidates.receipts.find(
    (candidate) => candidate.fingerprint === written.fingerprint
  )
  const existing = duplicate ?? candidates.receipts[0]
  if (existing) {
    return {
      inserted: false,
      existing: { verdict: 'readable', receipt: existing },
      reason: duplicate ? 'duplicate' : 'conflict'
    }
  }
  db.prepare(`INSERT INTO agent_session_command_receipts
      (operation_id, session_id, caller_key, method, fingerprint, status,
       result_json, rejection_json, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    written.operationId,
    written.sessionId,
    written.callerKey,
    written.method,
    written.fingerprint,
    written.status,
    written.status === 'accepted' ? JSON.stringify(written.result) : null,
    written.status === 'rejected' ? JSON.stringify(written.rejection) : null,
    written.acceptedAt
  )
  return { inserted: true }
}
