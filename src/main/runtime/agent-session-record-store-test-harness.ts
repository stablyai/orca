/** Centralize store fixtures in the host chat-journal DB; closeTestJournalHostDatabases owns their cleanup. */

import type { AgentSessionOperationRow } from '../../shared/agent-session-operation-ledger'
import type { PersistedAgentSessionRecord } from '../../shared/agent-session-legacy-handoff-lease'
import {
  encodePersistedAgentSessionProviderHandle,
  isAgentSessionProviderHandle
} from '../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { JOURNAL_DB_SCHEMA_VERSION } from '../native-chat/agent-session-journal/journal-database-schema'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import type Database from '../sqlite/sync-database'
import { AgentSessionRecordStore } from './agent-session-record-store'
import type { RetiredAgentSessionClaimKey } from './agent-session-store-state'

const TEST_HOST_ID = 'local'

export type PersistedTestAgentSessionStore = {
  /** Every record row as stored, including one this build cannot read. */
  records: Record<string, PersistedAgentSessionRecord>
  operations: Record<string, AgentSessionOperationRow>
  retiredClaimKeys: RetiredAgentSessionClaimKey[]
  /** Written as raw record rows; always empty on a read, where `records` holds every row. */
  unusableRecords: Record<string, { reason: string; raw: unknown }>
  /** Absent until the store first records a chat tab. */
  sessionTabs?: { tabId: string; sessionId: string }[]
}

function databaseFor(stateDirectory: string): Database.Database {
  return openTestJournalHostDatabase(stateDirectory).db
}

export async function openTestAgentSessionRecordStore(
  stateDirectory: string,
  options: { hostId?: string; legacySessionTabIds?: readonly string[] } = {}
): Promise<AgentSessionRecordStore> {
  return AgentSessionRecordStore.open({
    journalDatabase: openTestJournalHostDatabase(stateDirectory),
    hostId: options.hostId ?? TEST_HOST_ID,
    legacySessionTabIds: options.legacySessionTabIds ?? []
  })
}

function writePersisted(db: Database.Database, persisted: PersistedTestAgentSessionStore): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const table of [
      'agent_session_records',
      'agent_session_operations',
      'agent_session_retired_claim_keys',
      'agent_session_tabs',
      'agent_session_store_meta'
    ]) {
      db.prepare(`DELETE FROM ${table}`).run()
    }
    const insertRecord = db.prepare(
      'INSERT OR REPLACE INTO agent_session_records (session_id, record_json) VALUES (?, ?)'
    )
    for (const [sessionId, { raw }] of Object.entries(persisted.unusableRecords)) {
      insertRecord.run(sessionId, JSON.stringify(raw ?? null))
    }
    for (const [sessionId, record] of Object.entries(persisted.records)) {
      insertRecord.run(sessionId, JSON.stringify(record))
    }
    for (const [key, row] of Object.entries(persisted.operations)) {
      db.prepare(
        'INSERT INTO agent_session_operations (operation_key, row_json) VALUES (?, ?)'
      ).run(key, JSON.stringify(row))
    }
    for (const { keyId, retiredAt } of persisted.retiredClaimKeys) {
      db.prepare(
        'INSERT INTO agent_session_retired_claim_keys (key_id, retired_at) VALUES (?, ?)'
      ).run(keyId, retiredAt)
    }
    if (persisted.sessionTabs) {
      persisted.sessionTabs.forEach(({ tabId, sessionId }, position) =>
        db
          .prepare('INSERT INTO agent_session_tabs (tab_id, session_id, position) VALUES (?, ?, ?)')
          .run(tabId, sessionId, position)
      )
      db.prepare(
        "INSERT INTO agent_session_store_meta (key, value) VALUES ('session_tabs_recorded', '1')"
      ).run()
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Accept live fixtures or raw rows, whose handles already use persisted form. */
export function storedTestAgentSessionRecord(
  record: AgentSessionRecord | PersistedAgentSessionRecord
): PersistedAgentSessionRecord {
  return {
    ...record,
    providerHandleChain: record.providerHandleChain.map((link) => ({
      ...link,
      handle: isAgentSessionProviderHandle(link.handle)
        ? encodePersistedAgentSessionProviderHandle(link.handle)
        : link.handle
    }))
  }
}

export async function seedTestAgentSessionRecordStore(
  stateDirectory: string,
  seed: {
    records: readonly (AgentSessionRecord | PersistedAgentSessionRecord)[]
    sessionTabs?: { tabId: string; sessionId: string }[]
  }
): Promise<void> {
  writePersisted(databaseFor(stateDirectory), {
    records: Object.fromEntries(
      seed.records.map((record) => [record.sessionId, storedTestAgentSessionRecord(record)])
    ),
    operations: {},
    retiredClaimKeys: [],
    unusableRecords: {},
    ...(seed.sessionTabs ? { sessionTabs: seed.sessionTabs } : {})
  })
}

/** Seed a newer-build database that this host can read but never write. */
export async function seedTestAgentSessionStoreFromNewerBuild(
  stateDirectory: string
): Promise<void> {
  openTestJournalHostDatabase(stateDirectory).db.pragma(
    `user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`
  )
  closeTestJournalHostDatabase(stateDirectory)
}

function parsed(json: unknown): unknown {
  return typeof json === 'string' ? JSON.parse(json) : null
}

export async function readPersistedTestAgentSessionStore(
  stateDirectory: string
): Promise<PersistedTestAgentSessionStore> {
  const db = databaseFor(stateDirectory)
  const persisted: PersistedTestAgentSessionStore = {
    records: {},
    operations: {},
    retiredClaimKeys: [],
    unusableRecords: {}
  }
  for (const row of db
    .prepare('SELECT session_id, record_json FROM agent_session_records ORDER BY rowid')
    .all()) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test read-back of rows the store wrote; a test asserting on a malformed row reads it as the value it stored.
    persisted.records[String(row.session_id)] = parsed(
      row.record_json
    ) as PersistedAgentSessionRecord
  }
  for (const row of db
    .prepare('SELECT operation_key, row_json FROM agent_session_operations ORDER BY rowid')
    .all()) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test read-back of rows the store wrote after validating them.
    persisted.operations[String(row.operation_key)] = parsed(
      row.row_json
    ) as AgentSessionOperationRow
  }
  for (const row of db
    .prepare('SELECT key_id, retired_at FROM agent_session_retired_claim_keys ORDER BY rowid')
    .all()) {
    persisted.retiredClaimKeys.push({
      keyId: String(row.key_id),
      retiredAt: Number(row.retired_at)
    })
  }
  if (
    db
      .prepare(
        "SELECT 1 AS present FROM agent_session_store_meta WHERE key = 'session_tabs_recorded'"
      )
      .get()
  ) {
    persisted.sessionTabs = db
      .prepare('SELECT tab_id, session_id FROM agent_session_tabs ORDER BY position')
      .all()
      .map((row) => ({ tabId: String(row.tab_id), sessionId: String(row.session_id) }))
  }
  return persisted
}

/** Compare committed text to prove a value/action never changed disk state. */
export async function readPersistedTestAgentSessionStoreText(
  stateDirectory: string
): Promise<string> {
  return JSON.stringify(await readPersistedTestAgentSessionStore(stateDirectory))
}

/** Simulate older-build or disk changes outside the open store. */
export async function editPersistedTestAgentSessionStore(
  stateDirectory: string,
  edit: (persisted: PersistedTestAgentSessionStore) => void
): Promise<void> {
  const persisted = await readPersistedTestAgentSessionStore(stateDirectory)
  edit(persisted)
  writePersisted(databaseFor(stateDirectory), persisted)
}
