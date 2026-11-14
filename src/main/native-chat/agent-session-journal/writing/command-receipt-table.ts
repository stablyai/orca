import type { SqliteRow } from '../../../sqlite/sqlite-statement'
import type Database from '../../../sqlite/sync-database'
import { journalPragmaNumber } from '../database/journal-database'
import { JOURNAL_DB_SCHEMA_VERSION } from '../database/journal-database-schema'
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

export type CommandReceiptDiscovery =
  | { verdict: 'readable'; attempts: ExistingCommandReceipt[] }
  | { verdict: 'unreadable' }

/** Scope legacy discovery in SQL before decoding any saved result. */
export function discoverTaggedSendReceipts(
  db: Database.Database,
  targets: readonly { sessionId: string; tag: string }[]
): Map<string, CommandReceiptDiscovery> {
  const found = new Map<string, CommandReceiptDiscovery>()
  const unreadable = (): Map<string, CommandReceiptDiscovery> =>
    new Map(targets.map((target) => [target.sessionId, { verdict: 'unreadable' }]))
  let matching: ReturnType<Database.Database['prepare']>
  let competing: ReturnType<Database.Database['prepare']>
  try {
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('agent_session_command_receipts')
    ) {
      return unreadable()
    }
    matching = db.prepare(`SELECT DISTINCT operation_id FROM agent_session_command_receipts
      WHERE session_id = ? AND method = 'agentSession.send'
        AND operation_id >= ? AND operation_id < ? AND substr(operation_id, 15, 16) = ?
      ORDER BY operation_id`)
    competing = db.prepare(`${SELECT_RECEIPT} WHERE operation_id = ? ORDER BY rowid`)
  } catch (error) {
    if (unreadableReceiptError(error)) {
      return unreadable()
    }
    throw error
  }
  for (const target of targets) {
    try {
      const rows = matching.all(target.sessionId, '0000000000000-', '9999999999999.', target.tag)
      const attempts: ExistingCommandReceipt[] = []
      for (const row of rows) {
        const operationId = String(row.operation_id)
        const scope = { kind: 'global' } as const
        const candidates = decodeCommandReceiptRows(competing.all(operationId), scope, operationId)
        if (candidates.verdict === 'unreadable') {
          attempts.push(candidates)
        } else if (candidates.receipts[0]) {
          attempts.push({ verdict: 'readable', receipt: candidates.receipts[0] })
        }
      }
      found.set(target.sessionId, { verdict: 'readable', attempts })
    } catch (error) {
      if (unreadableReceiptError(error)) {
        found.set(target.sessionId, { verdict: 'unreadable' })
      } else {
        throw error
      }
    }
  }
  return found
}

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
    // Missing tables in newer read-only databases cannot authorize a command retry.
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
    return decodeCommandReceiptRows(rows, scope, operationId)
  } catch (error) {
    if (unreadableReceiptError(error)) {
      return unreadable
    }
    throw error
  }
}

function unreadableReceiptError(error: unknown): boolean {
  return (
    error instanceof RangeError ||
    error instanceof SyntaxError ||
    (error instanceof Error &&
      'code' in error &&
      error.code === 'ERR_SQLITE_ERROR' &&
      /^no such (?:column|table):/.test(error.message))
  )
}

function decodeCommandReceiptRows(
  rows: readonly SqliteRow[],
  scope: CommandReceiptScope,
  operationId: string
): CommandReceiptCandidates {
  const unreadable = { verdict: 'unreadable', scope, operationId } as const
  try {
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
    if (unreadableReceiptError(error)) {
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

/** Insert inside the effect's transaction; never reserve or commit independently. */
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
