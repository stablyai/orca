// Session records, keys and tabs loaded at open, with changed rows written back at commit.
//
// A record row this build cannot read is derived as unreadable at each load and never rewritten: a
// write only touches changed rows, and every mutation of an unreadable id is refused.

import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  isPersistedAgentSessionRecord,
  type AgentSessionLease
} from '../../shared/agent-session-record'
import { decodePersistedAgentSessionRecord } from '../../shared/agent-session-record-stored-form'
import type Database from '../sqlite/sync-database'
import type { SqliteRow } from '../sqlite/sqlite-statement'
import type { AgentSessionStoreState } from './agent-session-store-state'
import { AgentSessionOperationRepository } from './agent-session-operation-repository'
import type { AgentSessionStoreRowWrites } from './agent-session-store-draft'
import {
  isReadableAgentSessionStoreRecord,
  isReadableAgentSessionStoreTab,
  isReadableRetiredAgentSessionClaimKey
} from './agent-session-store-row-rules'
import { AgentSessionTabTable, type PersistedAgentSessionTab } from './agent-session-tab-table'

/** "Never recorded" and "recorded, now empty" differ, and #17439's legacy fallback needs the first;
 *  no row count can say which. */
const SESSION_TABS_RECORDED = 'session_tabs_recorded'

/** Latch fields older builds wrote. Nothing reads them, and dropping them keeps a lease this build
 *  writes back from carrying a stale latch to an older build after a downgrade. */
type RetiredAgentSessionLeaseFields = {
  processlessAt?: unknown
  settlementRetryRequired?: unknown
  settlementRetryId?: unknown
}

export function withoutRetiredLeaseLatches(lease: AgentSessionLease): AgentSessionLease {
  const {
    processlessAt: _processlessAt,
    settlementRetryRequired: _settlementRetryRequired,
    settlementRetryId: _settlementRetryId,
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

/**
 * Every lease loads unreconciled: the process that wrote it may still be alive. Unreadable record
 * rows are set aside, unreadable keys and tabs skipped, and operation receipts stay on disk.
 */
export function loadAgentSessionStoreRows(
  database: () => Database.Database
): AgentSessionStoreState {
  const db = database()
  const state: AgentSessionStoreState = {
    records: new Map(),
    operations: new AgentSessionOperationRepository(database),
    retiredClaimKeys: [],
    unreadableRecords: new Map(),
    sessionTabs: null
  }
  // Only a read-only database a newer build wrote can lack them; its chats then list as none here.
  if (
    !db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('agent_session_records')
  ) {
    return state
  }
  for (const row of db
    .prepare('SELECT session_id, record_json FROM agent_session_records ORDER BY rowid')
    .all()) {
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
      state.unreadableRecords.set(sessionId, {
        reason: unreadableRecordReason(value),
        raw: value
      })
    }
  }
  for (const row of db
    .prepare(
      'SELECT key_id AS keyId, retired_at AS retiredAt FROM agent_session_retired_claim_keys ORDER BY rowid'
    )
    .all()) {
    const entry = { keyId: row.keyId, retiredAt: Number(row.retiredAt) }
    if (isReadableRetiredAgentSessionClaimKey(entry)) {
      state.retiredClaimKeys.push(entry)
    }
  }
  const recorded = db
    .prepare('SELECT 1 AS present FROM agent_session_store_meta WHERE key = ?')
    .get(SESSION_TABS_RECORDED)
  const table = new AgentSessionTabTable()
  for (const row of db
    .prepare(
      'SELECT tab_id AS tabId, session_id AS sessionId FROM agent_session_tabs ORDER BY position'
    )
    .all()) {
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

function writeTabIndex(
  db: Database.Database,
  index: { recorded: boolean; tabs: readonly PersistedAgentSessionTab[] }
): void {
  db.prepare('DELETE FROM agent_session_tabs').run()
  const insert = db.prepare(
    'INSERT INTO agent_session_tabs (tab_id, session_id, position) VALUES (?, ?, ?)'
  )
  index.tabs.forEach(({ tabId, sessionId }, position) => insert.run(tabId, sessionId, position))
  if (index.recorded) {
    db.prepare('INSERT OR REPLACE INTO agent_session_store_meta (key, value) VALUES (?, ?)').run(
      SESSION_TABS_RECORDED,
      '1'
    )
  } else {
    db.prepare('DELETE FROM agent_session_store_meta WHERE key = ?').run(SESSION_TABS_RECORDED)
  }
}

/** Exactly the rows a transaction changed. The caller holds the journal transaction. */
export function writeAgentSessionStoreRows(
  db: Database.Database,
  writes: AgentSessionStoreRowWrites
): void {
  const upsertRecord = db.prepare(
    'INSERT INTO agent_session_records (session_id, record_json) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET record_json = excluded.record_json'
  )
  for (const [sessionId, json] of writes.records.upsert) {
    upsertRecord.run(sessionId, json)
  }
  for (const sessionId of writes.records.remove) {
    db.prepare('DELETE FROM agent_session_records WHERE session_id = ?').run(sessionId)
  }
  if (writes.retiredClaimKeys) {
    db.prepare('DELETE FROM agent_session_retired_claim_keys').run()
    const insert = db.prepare(
      'INSERT INTO agent_session_retired_claim_keys (key_id, retired_at) VALUES (?, ?)'
    )
    for (const { keyId, retiredAt } of writes.retiredClaimKeys) {
      insert.run(keyId, retiredAt)
    }
  }
  if (writes.sessionTabs) {
    writeTabIndex(db, writes.sessionTabs)
  }
}
