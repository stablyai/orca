import {
  journalTable,
  type JournalTableScope
} from '../../../native-chat/agent-session-journal/journal-table-scope'
import type { SQLInputValue } from 'node:sqlite'
import type { JournalReadConnection } from '../../../native-chat/agent-session-journal/journal-sql-owner'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
// Load session/ledger rows once and persist only changed rows inside the journal transaction.
// Unreadable records remain present and immutable; every mutation of their ids is refused.

import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  isPersistedAgentSessionRecord,
  isPersistedAgentSessionObservationRecord,
  type AgentSessionLease
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { decodePersistedAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record-stored-form'
import type Database from '../../../sqlite/sync-database'
import type { SqliteRow } from '../../../sqlite/sqlite-statement'
import type { AgentSessionStoreState } from './agent-session-store-state'
import type { AgentSessionStoreRowWrites } from './agent-session-store-draft'
import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import {
  isReadableAgentSessionStoreOperation,
  isReadableAgentSessionStoreRecord,
  isReadableAgentSessionStoreTab,
  isReadableRetiredAgentSessionClaimKey
} from './agent-session-store-row-rules'
import { AgentSessionTabTable, type PersistedAgentSessionTab } from '../agent-session-tab-table'

/** Never-recorded differs from recorded-empty; legacy fallback cannot infer this from row count (#17439). */
const SESSION_TABS_RECORDED = 'session_tabs_recorded'

/** Drop retired lease fields during load so later writes cannot carry them forward. */
type RetiredAgentSessionLeaseFields = {
  processlessAt?: unknown
  settlementRetryRequired?: unknown
  settlementRetryId?: unknown
  journalCheckpoint?: unknown
}

export function withoutRetiredLeaseLatches(lease: AgentSessionLease): AgentSessionLease {
  const {
    processlessAt: _processlessAt,
    settlementRetryRequired: _settlementRetryRequired,
    settlementRetryId: _settlementRetryId,
    journalCheckpoint: _journalCheckpoint,
    ...current
  }: AgentSessionLease & RetiredAgentSessionLeaseFields = lease
  return current
}

function text(row: SqliteRow, column: string): string | null {
  const value = row[column]
  return typeof value === 'string' ? value : null
}

function parseJson(json: string | null): { ok: true; value: unknown } | { ok: false } {
  if (json === null) {
    return { ok: false }
  }
  try {
    return { ok: true, value: JSON.parse(json) }
  } catch {
    return { ok: false }
  }
}

function unreadableRecordReason(value: unknown): string {
  if (isPersistedAgentSessionRecord(value)) {
    return 'record_key_session_id_mismatch'
  }
  const schemaVersion =
    typeof value === 'object' && value !== null && 'schemaVersion' in value
      ? value.schemaVersion
      : undefined
  return schemaVersion === AGENT_SESSION_RECORD_SCHEMA_VERSION
    ? 'current_shape_invalid'
    : 'unsupported_schema'
}

/** Loaded leases are unreconciled until this host proves ownership; persisted state alone grants no writer.
 * Unreadable operation/key/tab rows are skipped; unreadable records are set aside intact. */
type StoreRead = { sql: string; parameters: SQLInputValue[]; one?: boolean }
function* loadAgentSessionStoreSteps(): Generator<
  StoreRead | null,
  AgentSessionStoreState,
  SqliteRow[]
> {
  let examined = 0
  const state: AgentSessionStoreState = {
    records: new Map(),
    operations: new Map(),
    retiredClaimKeys: [],
    unreadableRecords: new Map(),
    sessionTabs: null
  }
  // Read-only newer databases may lack tables; report no chats without creating them.
  if (
    (yield {
      sql: "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      parameters: ['agent_session_records'],
      one: true
    }).length === 0
  ) {
    return state
  }
  for (const row of yield {
    sql: 'SELECT session_id, record_json FROM agent_session_records ORDER BY rowid',
    parameters: []
  }) {
    if (++examined % 128 === 0) {
      yield null
    }
    const sessionId = text(row, 'session_id')
    if (sessionId === null) {
      continue
    }
    const parsed = parseJson(text(row, 'record_json'))
    const value = parsed.ok ? parsed.value : text(row, 'record_json')
    if (parsed.ok && isReadableAgentSessionStoreRecord(sessionId, value)) {
      const { record } = decodePersistedAgentSessionRecord(value)
      state.records.set(sessionId, {
        ...record,
        lease: { ...withoutRetiredLeaseLatches(record.lease), unreconciled: true }
      })
    } else {
      const decoded =
        isPersistedAgentSessionObservationRecord(value) && value.sessionId === sessionId
          ? decodePersistedAgentSessionRecord(structuredClone(value)).record
          : undefined
      const conversation = decoded
        ? agentSessionConversationView({
            ...decoded,
            lease: { ...decoded.lease, unreconciled: true }
          })
        : undefined
      state.unreadableRecords.set(sessionId, {
        reason: unreadableRecordReason(value),
        raw: value,
        ...(conversation ? { conversation: Object.freeze(conversation) } : {})
      })
    }
  }
  for (const row of yield {
    sql: 'SELECT operation_key, row_json FROM agent_session_operations ORDER BY rowid',
    parameters: []
  }) {
    if (++examined % 128 === 0) {
      yield null
    }
    const key = text(row, 'operation_key')
    const parsed = parseJson(text(row, 'row_json'))
    if (key !== null && parsed.ok && isReadableAgentSessionStoreOperation(key, parsed.value)) {
      state.operations.set(key, parsed.value)
    }
  }
  for (const row of yield {
    sql: 'SELECT key_id AS keyId, retired_at AS retiredAt FROM agent_session_retired_claim_keys ORDER BY rowid',
    parameters: []
  }) {
    if (++examined % 128 === 0) {
      yield null
    }
    const entry = { keyId: row.keyId, retiredAt: Number(row.retiredAt) }
    if (isReadableRetiredAgentSessionClaimKey(entry)) {
      state.retiredClaimKeys.push(entry)
    }
  }
  const recorded =
    (yield {
      sql: 'SELECT 1 AS present FROM agent_session_store_meta WHERE key = ?',
      parameters: [SESSION_TABS_RECORDED],
      one: true
    }).length > 0
  const table = new AgentSessionTabTable()
  for (const row of yield {
    sql: 'SELECT tab_id AS tabId, session_id AS sessionId FROM agent_session_tabs ORDER BY position',
    parameters: []
  }) {
    if (++examined % 128 === 0) {
      yield null
    }
    const entry = { tabId: row.tabId, sessionId: row.sessionId }
    if (
      isReadableAgentSessionStoreTab(entry) &&
      table.sessionIdFor(entry.tabId) === undefined &&
      table.tabIdFor(entry.sessionId) === undefined
    ) {
      table.show(entry.sessionId, entry.tabId)
    }
  }
  if (recorded) {
    state.sessionTabs = table
  }
  return state
}

export function loadAgentSessionStoreRows(db: Database.Database): AgentSessionStoreState {
  const steps = loadAgentSessionStoreSteps()
  let rows: SqliteRow[] = []
  for (;;) {
    const next = steps.next(rows)
    if (next.done) {
      return next.value
    }
    const query = next.value
    if (query) {
      const statement = db.prepare(query.sql)
      const row = query.one ? statement.get(...query.parameters) : undefined
      rows = query.one ? (row ? [row] : []) : statement.all(...query.parameters)
    }
  }
}

export async function loadAgentSessionStoreRowsAsync(
  read: JournalReadConnection
): Promise<AgentSessionStoreState> {
  const steps = loadAgentSessionStoreSteps()
  let rows: SqliteRow[] = []
  for (;;) {
    const next = steps.next(rows)
    if (next.done) {
      return next.value
    }
    const query = next.value
    if (!query) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    } else {
      const statement = read.prepare(query.sql)
      const row = query.one ? await statement.get(...query.parameters) : undefined
      rows = query.one ? (row ? [row] : []) : await statement.all(...query.parameters)
    }
  }
}

function writeTabIndex(
  db: Database.Database,
  index: { recorded: boolean; tabs: readonly PersistedAgentSessionTab[] },
  tableScope: JournalTableScope = 'main'
): void {
  db.prepare(`DELETE FROM ${journalTable(tableScope, 'agent_session_tabs')}`).run()
  const insert = db.prepare(
    `INSERT INTO ${journalTable(tableScope, 'agent_session_tabs')} (tab_id, session_id, position) VALUES (?, ?, ?)`
  )
  index.tabs.forEach(({ tabId, sessionId }, position) => insert.run(tabId, sessionId, position))
  if (index.recorded) {
    db.prepare(
      `INSERT OR REPLACE INTO ${journalTable(tableScope, 'agent_session_store_meta')} (key, value) VALUES (?, ?)`
    ).run(SESSION_TABS_RECORDED, '1')
  } else {
    db.prepare(
      `DELETE FROM ${journalTable(tableScope, 'agent_session_store_meta')} WHERE key = ?`
    ).run(SESSION_TABS_RECORDED)
  }
}

// TEMPORARY: ledger co-write preserves cross-family identity until every mutation uses receipts.
export function insertAgentSessionOperationRowsIfAbsent(
  db: Database.Database,
  rows: AgentSessionStoreRowWrites['operations']['upsert'],
  tableScope: JournalTableScope = 'main'
): void {
  const insert = db.prepare(
    `INSERT INTO ${journalTable(tableScope, 'agent_session_operations')} (operation_key, row_json) VALUES (?, ?) ON CONFLICT(operation_key) DO NOTHING`
  )
  for (const [key, json] of rows) {
    if (insert.run(key, json).changes === 0) {
      throw agentSessionRefusalError('agent_session_operation_unknown', {
        reason: 'outcomeUnknown'
      })
    }
  }
}

/** Exactly the rows a transaction changed. The caller holds the journal transaction. */
export function writeAgentSessionStoreRows(
  db: Database.Database,
  writes: AgentSessionStoreRowWrites,
  tableScope: JournalTableScope = 'main'
): void {
  const upsertRecord = db.prepare(
    `INSERT INTO ${journalTable(tableScope, 'agent_session_records')} (session_id, record_json) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET record_json = excluded.record_json`
  )
  for (const [sessionId, json] of writes.records.upsert) {
    upsertRecord.run(sessionId, json)
  }
  for (const sessionId of writes.records.remove) {
    db.prepare(
      `DELETE FROM ${journalTable(tableScope, 'agent_session_records')} WHERE session_id = ?`
    ).run(sessionId)
  }
  const upsertOperation = db.prepare(
    `INSERT INTO ${journalTable(tableScope, 'agent_session_operations')} (operation_key, row_json) VALUES (?, ?) ON CONFLICT(operation_key) DO UPDATE SET row_json = excluded.row_json`
  )
  for (const [key, json] of writes.operations.upsert) {
    upsertOperation.run(key, json)
  }
  for (const key of writes.operations.remove) {
    db.prepare(
      `DELETE FROM ${journalTable(tableScope, 'agent_session_operations')} WHERE operation_key = ?`
    ).run(key)
  }
  if (writes.retiredClaimKeys) {
    db.prepare(`DELETE FROM ${journalTable(tableScope, 'agent_session_retired_claim_keys')}`).run()
    const insert = db.prepare(
      `INSERT INTO ${journalTable(tableScope, 'agent_session_retired_claim_keys')} (key_id, retired_at) VALUES (?, ?)`
    )
    for (const { keyId, retiredAt } of writes.retiredClaimKeys) {
      insert.run(keyId, retiredAt)
    }
  }
  if (writes.sessionTabs) {
    writeTabIndex(db, writes.sessionTabs, tableScope)
  }
}
