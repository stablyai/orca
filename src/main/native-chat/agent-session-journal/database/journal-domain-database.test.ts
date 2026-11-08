import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../../sqlite/sync-database'
import {
  createJournalTablesSql,
  createAgentSessionRecordTablesSql
} from './journal-database-schema'
import { openJournalDatabase } from './journal-database'
import { journalDatabasePath } from './journal-host-database'
import {
  initializeJournalDomainDatabase,
  journalDomainDatabasePath,
  openJournalDomainDatabase
} from './journal-domain-database'
import { migrateJournalDomainSchema } from '../journal-domain-schema'
import { migrateJournalDomainPredecessor } from './journal-domain-migrations.test-fixture'
import { createJournalReducerState } from '../projection/journal-reducer'
import { readJournalLegacyCards } from '../queued-messages/journal-queue-import'

const cleanup: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).toReversed()) {
    close()
  }
})

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'orca-domain-database-'))
  cleanup.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

function open(filename: string): Database.Database {
  const { db, readOnly } = openJournalDomainDatabase(filename)
  cleanup.push(() => db.close())
  expect(readOnly).toBe(false)
  return db
}

function legacy(stateDirectory: string): Database.Database {
  const filename = journalDatabasePath(stateDirectory)
  const seed = new Database(filename)
  seed.exec(createJournalTablesSql() + createAgentSessionRecordTablesSql())
  seed.pragma('user_version=4')
  seed.close()
  const { db } = openJournalDatabase(filename)
  cleanup.push(() => db.close())
  db.pragma('wal_autocheckpoint=0')
  return db
}

function hash(filename: string): string {
  return createHash('sha256').update(readFileSync(filename)).digest('hex')
}

function sourceHashes(stateDirectory: string) {
  const filename = journalDatabasePath(stateDirectory)
  return [hash(filename), hash(`${filename}-wal`)]
}

function seedSource(db: Database.Database): void {
  db.exec(`INSERT INTO journal_sessions VALUES('chat','workspace','epoch');
    INSERT INTO journal_rows VALUES('chat','epoch',1,100,'wal-backed source row');
    INSERT INTO agent_session_records VALUES('chat','{"title":"original"}');
    INSERT INTO agent_session_tabs VALUES('tab','chat',1);
    INSERT INTO agent_session_operations VALUES('operation','{"owner":"original"}');
    INSERT INTO agent_session_retired_claim_keys VALUES('retired',10);
    INSERT INTO agent_session_attachment_claims VALUES('upload','chat',100);
    INSERT INTO agent_session_command_receipts VALUES('operation','chat','caller','send','fingerprint',
      'accepted','{"kind":"stop"}',NULL,100);
    INSERT INTO queued_messages(session_id,message_id,position,body_json,fingerprint,created_at,
      host_instance,state) VALUES('chat','queued',1,'{}','fingerprint',100,'host','waiting');
    INSERT INTO journal_outcome_generations VALUES(1,'chat','epoch');
    INSERT INTO journal_outcome_epochs VALUES('chat','epoch',1,3,1,0);
    INSERT INTO journal_outcomes VALUES(1,1,'field','entry',3,'1','source outcome',0)`)
}

it('creates a fresh incremental store with records, ownership, attachments and receipts in one ledger', async () => {
  const stateDirectory = directory()
  const filename = await initializeJournalDomainDatabase(stateDirectory)
  expect(filename).toBe(journalDomainDatabasePath(stateDirectory))
  expect(filename).not.toBe(journalDatabasePath(stateDirectory))
  const db = open(filename)
  seedSource(db)
  db.exec(`INSERT INTO journal_chat_state(session_id,epoch,last_sequence,highest_fence)
    VALUES('chat','epoch',2,1)`)
  expect(db.pragma('auto_vacuum', { simple: true })).toBe(2)
  expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  expect(
    db
      .prepare(`SELECT name FROM sqlite_schema WHERE name='journal_domain_migrations'
      OR name GLOB 'journal_proj_*'`)
      .all()
  ).toEqual([])
  const reopened = open(filename)
  expect(reopened.prepare('SELECT record_json FROM agent_session_records').get()).toEqual({
    record_json: '{"title":"original"}'
  })
  expect(reopened.prepare('SELECT last_sequence FROM journal_chat_state').get()).toEqual({
    last_sequence: 2
  })
  expect(reopened.prepare('SELECT result_json FROM agent_session_command_receipts').get()).toEqual({
    result_json: '{"kind":"stop"}'
  })
})

it('copies committed WAL rows without changing the original and removes mirrors only from the new file', async () => {
  const stateDirectory = directory()
  const source = legacy(stateDirectory)
  seedSource(source)
  source.exec(`CREATE TABLE journal_proj_obsolete(value TEXT);
    INSERT INTO journal_proj_obsolete VALUES('derived');
    CREATE TABLE journal_domain_migrations(version INTEGER PRIMARY KEY);
    INSERT INTO journal_domain_migrations VALUES(4)`)
  expect(source.pragma('auto_vacuum', { simple: true })).toBe(0)
  const before = sourceHashes(stateDirectory)
  const filename = await initializeJournalDomainDatabase(stateDirectory)
  const copied = open(filename)
  expect(copied.prepare('SELECT row_json FROM journal_rows').get()).toEqual({
    row_json: 'wal-backed source row'
  })
  expect(copied.prepare('SELECT value_json FROM journal_outcomes').get()).toEqual({
    value_json: 'source outcome'
  })
  expect(copied.prepare('SELECT tab_id, session_id FROM agent_session_tabs').get()).toEqual({
    tab_id: 'tab',
    session_id: 'chat'
  })
  expect(copied.prepare('SELECT row_json FROM agent_session_operations').get()).toEqual({
    row_json: '{"owner":"original"}'
  })
  expect(copied.prepare('SELECT upload_id FROM agent_session_attachment_claims').get()).toEqual({
    upload_id: 'upload'
  })
  expect(copied.prepare('SELECT message_id FROM queued_messages').get()).toEqual({
    message_id: 'queued'
  })
  expect(copied.pragma('auto_vacuum', { simple: true })).toBe(2)
  expect(
    copied
      .prepare(`SELECT name FROM sqlite_schema WHERE name GLOB 'journal_proj_*'
    OR name='journal_domain_migrations'`)
      .all()
  ).toEqual([])
  expect(source.prepare('SELECT value FROM journal_proj_obsolete').get()).toEqual({
    value: 'derived'
  })
  expect(source.pragma('user_version', { simple: true })).toBe(4)
  expect(source.pragma('auto_vacuum', { simple: true })).toBe(0)
  expect(sourceHashes(stateDirectory)).toEqual(before)
})

it('reopens the published file without importing later old-build writes or consulting a broken source', async () => {
  const stateDirectory = directory()
  const source = legacy(stateDirectory)
  seedSource(source)
  const filename = await initializeJournalDomainDatabase(stateDirectory)
  const current = open(filename)
  source.exec(`UPDATE journal_rows SET row_json='later old-build edit';
    INSERT INTO journal_rows VALUES('chat','epoch',2,200,'later old-build message')`)
  current.exec(`INSERT INTO journal_chat_state(session_id,epoch,last_sequence,highest_fence)
    VALUES('chat','epoch',3,1)`)
  expect(await initializeJournalDomainDatabase(stateDirectory)).toBe(filename)
  expect(current.prepare('SELECT row_json FROM journal_rows ORDER BY seq').all()).toEqual([
    { row_json: 'wal-backed source row' }
  ])
  const isolated = directory()
  const published = await initializeJournalDomainDatabase(isolated)
  writeFileSync(journalDatabasePath(isolated), 'unreadable old database')
  const before = hash(published)
  expect(await initializeJournalDomainDatabase(isolated)).toBe(published)
  expect(hash(published)).toBe(before)
  expect(open(filename).prepare('SELECT last_sequence FROM journal_chat_state').get()).toEqual({
    last_sequence: 3
  })
})

it('preserves early version-four queue rows without assuming later additive source columns', async () => {
  const stateDirectory = directory()
  const source = new Database(journalDatabasePath(stateDirectory))
  source.exec(createJournalTablesSql() + createAgentSessionRecordTablesSql())
  source.exec(`CREATE TABLE queued_messages (
    session_id TEXT NOT NULL, message_id TEXT NOT NULL, position INTEGER NOT NULL,
    body_json TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL,
    host_instance TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(session_id,message_id));
    PRAGMA user_version=4`)
  const body = '{"kind":"message","role":"user","blocks":[{"type":"text","text":"waiting"}]}'
  source
    .prepare(
      "INSERT INTO queued_messages VALUES('chat','original-message',1,?,'original fingerprint',100,'host','waiting')"
    )
    .run(body)
  source.close()
  const before = hash(journalDatabasePath(stateDirectory))
  const current = open(await initializeJournalDomainDatabase(stateDirectory))
  expect(current.prepare('SELECT * FROM queued_messages').all()).toEqual([
    {
      session_id: 'chat',
      message_id: 'original-message',
      position: 1,
      body_json: body,
      fingerprint: 'original fingerprint',
      created_at: 100,
      host_instance: 'host',
      state: 'waiting'
    }
  ])
  expect(readJournalLegacyCards(current, createJournalReducerState('chat', 'epoch'))).toMatchObject(
    [
      {
        messageId: 'original-message',
        position: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'waiting' }] },
        holdReason: null,
        returnedReason: null,
        returnedRejection: null,
        consumedAs: null,
        queuedAt: null
      }
    ]
  )
  expect(hash(journalDatabasePath(stateDirectory))).toBe(before)
})

it('publishes only a complete snapshot and never replaces another completed initializer', async () => {
  const stateDirectory = directory()
  seedSource(legacy(stateDirectory))
  const foreign = join(stateDirectory, '.journal-domain-import-other-process')
  mkdirSync(foreign)
  writeFileSync(join(foreign, 'snapshot.db'), 'another invocation')
  const backup = Database.prototype.backup
  let complete!: () => void
  let resume!: () => void
  const copied = new Promise<void>((resolve) => {
    complete = resolve
  })
  const held = new Promise<void>((resolve) => {
    resume = resolve
  })
  let temporary = ''
  vi.spyOn(Database.prototype, 'backup').mockImplementationOnce(async function (
    this: Database.Database,
    filename,
    options
  ) {
    temporary = dirname(filename)
    await backup.call(this, filename, options)
    complete()
    await held
  })
  const first = initializeJournalDomainDatabase(stateDirectory)
  await copied
  try {
    expect(existsSync(journalDomainDatabasePath(stateDirectory))).toBe(false)
    const winner = await initializeJournalDomainDatabase(stateDirectory)
    open(winner).exec(`INSERT INTO journal_chat_state(session_id,epoch,last_sequence,highest_fence)
      VALUES('winner','epoch',7,1)`)
    resume()
    expect(await first).toBe(winner)
    expect(
      open(winner).prepare('SELECT session_id,last_sequence FROM journal_chat_state').get()
    ).toEqual({
      session_id: 'winner',
      last_sequence: 7
    })
    expect(existsSync(temporary)).toBe(false)
    expect(readFileSync(join(foreign, 'snapshot.db'), 'utf8')).toBe('another invocation')
  } finally {
    resume()
    await first
  }
})

it('cleans only its private incomplete copy after backup fails and retries from the untouched source', async () => {
  const stateDirectory = directory()
  seedSource(legacy(stateDirectory))
  const before = sourceHashes(stateDirectory)
  const backup = Database.prototype.backup
  let temporary = ''
  vi.spyOn(Database.prototype, 'backup').mockImplementationOnce(async function (
    this: Database.Database,
    filename,
    options
  ) {
    temporary = dirname(filename)
    await backup.call(this, filename, options)
    throw new Error('interrupted backup')
  })
  await expect(initializeJournalDomainDatabase(stateDirectory)).rejects.toThrow(
    'interrupted backup'
  )
  expect(existsSync(journalDomainDatabasePath(stateDirectory))).toBe(false)
  expect(existsSync(temporary)).toBe(false)
  expect(sourceHashes(stateDirectory)).toEqual(before)
  const filename = await initializeJournalDomainDatabase(stateDirectory)
  expect(open(filename).prepare('SELECT row_json FROM journal_rows').get()).toEqual({
    row_json: 'wal-backed source row'
  })
})

it('retries a failed numbered migration in the published file without recopying or backfilling again', async () => {
  const stateDirectory = directory()
  const source = legacy(stateDirectory)
  seedSource(source)
  const filename = await initializeJournalDomainDatabase(stateDirectory)
  const db = new Database(filename)
  cleanup.push(() => db.close())
  migrateJournalDomainPredecessor(db, 5)
  db.exec(`INSERT INTO journal_items VALUES('chat','epoch','item',1,2,1,0,1,NULL,'invalid JSON')`)
  expect(() => openJournalDomainDatabase(filename)).toThrow()
  expect(db.pragma('user_version', { simple: true })).toBe(5)
  expect(() => db.prepare('SELECT root FROM journal_items')).toThrow()
  source.exec(`UPDATE journal_rows SET row_json='old-build edit after failed migration'`)
  const item = {
    itemId: 'item',
    revision: 2,
    sequence: 1,
    observedAt: 100,
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'preserved body' }]
    },
    turnScope: { kind: 'thread' }
  }
  db.prepare('UPDATE journal_items SET payload_json=?').run(JSON.stringify(item))
  expect(await initializeJournalDomainDatabase(stateDirectory)).toBe(filename)
  const recovered = open(filename)
  expect(recovered.prepare('SELECT root, revision, payload_json FROM journal_items').get()).toEqual(
    {
      root: 1,
      revision: 2,
      payload_json: JSON.stringify(item)
    }
  )
  expect(recovered.prepare('SELECT row_json FROM journal_rows').get()).toEqual({
    row_json: 'wal-backed source row'
  })
  recovered.exec('UPDATE journal_items SET root=0')
  expect(open(filename).prepare('SELECT root FROM journal_items').get()).toEqual({ root: 0 })
})

it('opens a newer store read-only before changing persistent pragmas or its only version ledger', () => {
  const filename = join(directory(), 'newer.db')
  const seed = new Database(filename)
  seed.exec(`CREATE TABLE future_records(value TEXT);
    INSERT INTO future_records VALUES('authoritative future data'); PRAGMA user_version=100`)
  seed.close()
  const before = hash(filename)
  const { db, readOnly } = openJournalDomainDatabase(filename)
  cleanup.push(() => db.close())
  expect(readOnly).toBe(true)
  expect(db.pragma('journal_mode', { simple: true })).toBe('delete')
  expect(db.pragma('auto_vacuum', { simple: true })).toBe(0)
  expect(db.prepare('SELECT value FROM future_records').get()).toEqual({
    value: 'authoritative future data'
  })
  expect(() => db.exec("INSERT INTO future_records VALUES('forbidden')")).toThrow(/readonly/i)
  expect(() => migrateJournalDomainSchema(db)).toThrow(
    'journal domain schema is newer than this writer'
  )
  expect(db.pragma('user_version', { simple: true })).toBe(100)
  expect(hash(filename)).toBe(before)
})
