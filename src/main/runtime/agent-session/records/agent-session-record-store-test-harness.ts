// @orca-isolated-worker -- Suite hooks own the temporary SQL worker bundle.
import { afterAll } from 'vitest'
/** Centralize store fixtures in the worker-owned journal DB; closeTestAgentSessionRecordStores owns their cleanup. */

import { resolve } from 'node:path'
import type { AgentSessionOperationRow } from '../../../../shared/agent-session/lifecycle/operations/agent-session-operation-ledger'
import type { PersistedAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/leases/agent-session-legacy-handoff-lease'
import {
  encodePersistedAgentSessionProviderHandle,
  isAgentSessionProviderHandle
} from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  initializeJournalDomainDatabase,
  openJournalDomainDatabase
} from '../../../native-chat/agent-session-journal/database/journal-domain-database'
import { JOURNAL_DOMAIN_SCHEMA_VERSION } from '../../../native-chat/agent-session-journal/database/journal-domain-migrations'
import { JournalSqlDatabase } from '../../../native-chat/agent-session-journal/database/journal-sql-database'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from '../../../native-chat/agent-session-journal/journal-sql-worker-bundle.test-fixture'
import type Database from '../../../sqlite/sync-database'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { openAgentSessionRecordStoreOnce } from './agent-session-record-store-slot'
import { ensureStructuredAgentSessionHost } from '../structured-agent-session-runtime'
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

const databases = new Map<string, Promise<JournalSqlDatabase>>()

afterAll(closeTestAgentSessionRecordStores)

export async function ensureTestStructuredAgentSessionHost(
  deps: Parameters<typeof ensureStructuredAgentSessionHost>[0]
): ReturnType<typeof ensureStructuredAgentSessionHost> {
  await openTestAgentSessionRecordStoreSlot({
    stateDirectory: deps.stateDirectory,
    hostId: deps.hostId,
    logger: deps.logger,
    legacySessionTabIds: deps.legacySessionTabIds ?? []
  })
  return ensureStructuredAgentSessionHost(deps)
}

export function openTestAgentSessionRecordStoreSlot(
  location: Omit<
    Parameters<typeof openAgentSessionRecordStoreOnce>[0],
    'writerPath' | 'readerPath' | 'onMaintenanceTick'
  > &
    Partial<Pick<Parameters<typeof openAgentSessionRecordStoreOnce>[0], 'onMaintenanceTick'>>
): ReturnType<typeof openAgentSessionRecordStoreOnce> {
  return openAgentSessionRecordStoreOnce({
    onMaintenanceTick: () => {},
    ...location,
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath()
  })
}

/** Stores reopened in one directory share its writer, like one runtime's slot. */
export function openTestAgentSessionDatabase(stateDirectory: string): Promise<JournalSqlDatabase> {
  const directory = resolve(stateDirectory)
  let opened = databases.get(directory)
  if (!opened) {
    opened = JournalSqlDatabase.open(directory, {
      writerPath: journalSqlWorkerPath(),
      readerPath: journalSqlReaderPath(),
      onMaintenanceError: () => {}
    })
    databases.set(directory, opened)
  }
  return opened
}

export async function closeTestAgentSessionDatabase(stateDirectory: string): Promise<void> {
  const directory = resolve(stateDirectory)
  const opened = databases.get(directory)
  databases.delete(directory)
  await (await opened)?.close()
}

export async function closeTestAgentSessionRecordStores(): Promise<void> {
  const opened = [...databases.values()]
  databases.clear()
  await Promise.all(opened.map(async (database) => (await database).close()))
}

export async function openTestAgentSessionRecordStore(
  stateDirectory: string,
  options: {
    hostId?: string
    legacySessionTabIds?: readonly string[]
    mode?: 'observe'
  } = {}
): Promise<AgentSessionRecordStore> {
  const journalDatabase = await openTestAgentSessionDatabase(stateDirectory)
  return AgentSessionRecordStore.open({
    journalDatabase,
    records: await (options.mode === 'observe'
      ? journalDatabase.loadRecords()
      : journalDatabase.installRecords()),
    hostId: options.hostId ?? TEST_HOST_ID,
    legacySessionTabIds: options.legacySessionTabIds ?? []
  })
}

/** A separate connection to the store's file, for seeding, read-back and injected failures. */
export async function withTestAgentSessionDatabase<T>(
  stateDirectory: string,
  read: (db: Database.Database) => T
): Promise<T> {
  const { db } = openJournalDomainDatabase(await initializeJournalDomainDatabase(stateDirectory))
  try {
    return read(db)
  } finally {
    db.close()
  }
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
  await withTestAgentSessionDatabase(stateDirectory, (db) =>
    writePersisted(db, {
      records: Object.fromEntries(
        seed.records.map((record) => [record.sessionId, storedTestAgentSessionRecord(record)])
      ),
      operations: {},
      retiredClaimKeys: [],
      unusableRecords: {},
      ...(seed.sessionTabs ? { sessionTabs: seed.sessionTabs } : {})
    })
  )
}

/** Seed a newer-build database that this host can read but never write. */
export async function seedTestAgentSessionStoreFromNewerBuild(
  stateDirectory: string
): Promise<void> {
  await closeTestAgentSessionRecordStores()
  await withTestAgentSessionDatabase(stateDirectory, (db) =>
    db.pragma(`user_version = ${JOURNAL_DOMAIN_SCHEMA_VERSION + 1}`)
  )
}

function parsed(json: unknown): unknown {
  return typeof json === 'string' ? JSON.parse(json) : null
}

export function readPersistedTestAgentSessionStore(
  stateDirectory: string
): Promise<PersistedTestAgentSessionStore> {
  return withTestAgentSessionDatabase(stateDirectory, readPersisted)
}

function readPersisted(db: Database.Database): PersistedTestAgentSessionStore {
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
  await withTestAgentSessionDatabase(stateDirectory, (db) => writePersisted(db, persisted))
}
