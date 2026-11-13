import {
  captureJournalLegacySourceReceipt,
  JOURNAL_LEGACY_SOURCE_RECEIPT
} from './journal-legacy-source-receipt'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { readMailWithdrawal } from '../writing/mail-withdrawal-receipts'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { migrateJournalDomainSchema } from '../journal-domain-schema'
import { JOURNAL_DOMAIN_SCHEMA_001 } from './journal-domain-schema-001'

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

it('publishes an empty incremental store that retains new authoritative state on reopen', async () => {
  const stateDirectory = directory()
  const filename = await initializeJournalDomainDatabase(stateDirectory)
  expect(filename).toBe(journalDomainDatabasePath(stateDirectory))
  const db = open(filename)
  db.exec(`INSERT INTO agent_session_records VALUES('new','{"title":"new chat"}');
    INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence)
    VALUES('workspace','new','epoch',2,1)`)
  expect(db.pragma('auto_vacuum', { simple: true })).toBe(2)
  expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  const reopened = open(await initializeJournalDomainDatabase(stateDirectory))
  expect(reopened.prepare('SELECT record_json FROM agent_session_records').get()).toEqual({
    record_json: '{"title":"new chat"}'
  })
  expect(reopened.prepare('SELECT last_sequence FROM journal_chat_state').get()).toEqual({
    last_sequence: 2
  })
})

it('copies opaque profile metadata in source order from the committed WAL, without copying transcripts or changing the original', async () => {
  const stateDirectory = directory()
  const source = legacy(stateDirectory)
  seedSource(source)
  source.exec(`INSERT INTO agent_session_records VALUES('a','unreadable opaque record');
    INSERT INTO agent_session_store_meta VALUES('tabs_recorded','1');
    INSERT INTO agent_session_attachment_sweeps VALUES('owed-upload',123)`)
  const before = sourceHashes(stateDirectory)
  const current = open(await initializeJournalDomainDatabase(stateDirectory))
  expect(
    current.prepare('SELECT session_id,record_json FROM agent_session_records ORDER BY rowid').all()
  ).toEqual([
    { session_id: 'chat', record_json: '{"title":"original"}' },
    { session_id: 'a', record_json: 'unreadable opaque record' }
  ])
  expect(
    current.prepare('SELECT session_id,workspace_id,epoch FROM journal_chat_state').all()
  ).toEqual([{ session_id: 'chat', workspace_id: 'workspace', epoch: null }])
  expect(
    current.prepare('SELECT tab_id,session_id,position FROM agent_session_tabs').get()
  ).toEqual({ tab_id: 'tab', session_id: 'chat', position: 1 })
  expect(current.prepare('SELECT row_json FROM agent_session_operations').get()).toEqual({
    row_json: '{"owner":"original"}'
  })
  expect(current.prepare('SELECT * FROM agent_session_retired_claim_keys').get()).toEqual({
    key_id: 'retired',
    retired_at: 10
  })
  expect(current.prepare('SELECT * FROM agent_session_store_meta').get()).toEqual({
    key: 'tabs_recorded',
    value: '1'
  })
  expect(current.prepare('SELECT result_json FROM agent_session_command_receipts').get()).toEqual({
    result_json: '{"kind":"stop"}'
  })
  expect(current.prepare('SELECT * FROM agent_session_attachment_claims').get()).toEqual({
    upload_id: 'upload',
    session_id: 'chat',
    claimed_at: 100
  })
  expect(current.prepare('SELECT * FROM agent_session_attachment_sweeps').get()).toEqual({
    upload_id: 'owed-upload',
    started_at: 123
  })
  expect(current.prepare('SELECT item_id FROM journal_items').all()).toEqual([])
  expect(source.prepare('SELECT row_json FROM journal_rows').get()).toEqual({
    row_json: 'wal-backed source row'
  })
  expect(sourceHashes(stateDirectory)).toEqual(before)
})

it('never reimports metadata or consults a broken original once the new file is published', async () => {
  const stateDirectory = directory()
  const source = legacy(stateDirectory)
  seedSource(source)
  const filename = await initializeJournalDomainDatabase(stateDirectory)
  const current = open(filename)
  source.exec(`UPDATE agent_session_records SET record_json='later old-build metadata'`)
  current.exec(`UPDATE agent_session_records SET record_json='new authoritative metadata'`)
  expect(await initializeJournalDomainDatabase(stateDirectory)).toBe(filename)
  expect(current.prepare('SELECT record_json FROM agent_session_records').get()).toEqual({
    record_json: 'new authoritative metadata'
  })
  const isolated = directory()
  const published = await initializeJournalDomainDatabase(isolated)
  writeFileSync(journalDatabasePath(isolated), 'unreadable old database')
  const before = hash(published)
  expect(await initializeJournalDomainDatabase(isolated)).toBe(published)
  expect(hash(published)).toBe(before)
})

it('accepts supported early schemas with no additive metadata tables without migrating their source', async () => {
  const stateDirectory = directory()
  const source = new Database(journalDatabasePath(stateDirectory))
  source.exec(createJournalTablesSql())
  source.exec(
    `INSERT INTO journal_sessions VALUES('early','workspace','epoch'); PRAGMA user_version=3`
  )
  source.close()
  const before = hash(journalDatabasePath(stateDirectory))
  const current = open(await initializeJournalDomainDatabase(stateDirectory))
  expect(
    current.prepare('SELECT session_id,workspace_id,epoch FROM journal_chat_state').all()
  ).toEqual([{ session_id: 'early', workspace_id: 'workspace', epoch: null }])
  expect(current.prepare('SELECT record_json FROM agent_session_records').all()).toEqual([])
  expect(hash(journalDatabasePath(stateDirectory))).toBe(before)
})

it('publishes complete metadata under competing initialization without replacing the winner or foreign files', async () => {
  const stateDirectory = directory()
  seedSource(legacy(stateDirectory))
  const foreign = join(stateDirectory, '.journal-domain-import-other-process')
  mkdirSync(foreign)
  writeFileSync(join(foreign, 'snapshot.db'), 'foreign evidence')
  const [first, second] = await Promise.all([
    initializeJournalDomainDatabase(stateDirectory),
    initializeJournalDomainDatabase(stateDirectory)
  ])
  expect(first).toBe(second)
  const winner = open(first)
  expect(winner.prepare('SELECT result_json FROM agent_session_command_receipts').get()).toEqual({
    result_json: '{"kind":"stop"}'
  })
  winner.exec(
    `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES('workspace','winner','epoch',7,1)`
  )
  expect(
    open(await initializeJournalDomainDatabase(stateDirectory))
      .prepare('SELECT session_id,last_sequence FROM journal_chat_state WHERE epoch IS NOT NULL')
      .get()
  ).toEqual({ session_id: 'winner', last_sequence: 7 })
  expect(readFileSync(join(foreign, 'snapshot.db'), 'utf8')).toBe('foreign evidence')
})

it('discards an unpublished partial metadata import on failure and retries from the intact original', async () => {
  const stateDirectory = directory()
  const source = legacy(stateDirectory)
  seedSource(source)
  source.exec(
    'ALTER TABLE agent_session_command_receipts RENAME COLUMN accepted_at TO invalid_column'
  )
  const before = sourceHashes(stateDirectory)
  await expect(initializeJournalDomainDatabase(stateDirectory)).rejects.toThrow(/accepted_at/)
  expect(existsSync(journalDomainDatabasePath(stateDirectory))).toBe(false)
  expect(
    readdirSync(stateDirectory).filter((entry) => entry.startsWith('.journal-domain-import-'))
  ).toEqual([])
  expect(sourceHashes(stateDirectory)).toEqual(before)
  source.exec(
    'ALTER TABLE agent_session_command_receipts RENAME COLUMN invalid_column TO accepted_at'
  )
  const current = open(await initializeJournalDomainDatabase(stateDirectory))
  expect(current.prepare('SELECT result_json FROM agent_session_command_receipts').get()).toEqual({
    result_json: '{"kind":"stop"}'
  })
})

it.each([1, 100, 'corrupt'])(
  'refuses source schema %s without publishing an empty successful profile',
  async (version) => {
    const stateDirectory = directory()
    const filename = journalDatabasePath(stateDirectory)
    if (version === 'corrupt') {
      writeFileSync(filename, 'corrupt database')
    } else {
      const source = new Database(filename)
      source.pragma(`user_version=${version}`)
      source.close()
    }
    const before = hash(filename)
    await expect(initializeJournalDomainDatabase(stateDirectory)).rejects.toThrow()
    expect(existsSync(journalDomainDatabasePath(stateDirectory))).toBe(false)
    expect(hash(filename)).toBe(before)
  }
)

it('opens a newer store read-only before changing persistent pragmas or its only version ledger', () => {
  const filename = join(directory(), 'newer.db')
  const seed = new Database(filename)
  seed.exec(
    `CREATE TABLE future_records(value TEXT); INSERT INTO future_records VALUES('authoritative future data'); PRAGMA user_version=100`
  )
  seed.close()
  const before = hash(filename)
  const { db, readOnly } = openJournalDomainDatabase(filename)
  cleanup.push(() => db.close())
  expect(readOnly).toBe(true)
  expect(db.prepare('SELECT value FROM future_records').get()).toEqual({
    value: 'authoritative future data'
  })
  expect(() => db.exec("INSERT INTO future_records VALUES('forbidden')")).toThrow(/readonly/i)
  expect(() => migrateJournalDomainSchema(db)).toThrow(
    'journal domain schema is newer than this writer'
  )
  expect(hash(filename)).toBe(before)
})

it('preserves positive person and historical system deletion evidence from imported profiles', async () => {
  const stateDirectory = directory()
  const source = legacy(stateDirectory)
  seedSource(source)
  for (const [operation, caller] of [
    ['person-card', 'trusted-local:desktop'],
    ['system-card', 'trusted-local:orchestration:session:chat']
  ]) {
    const fingerprint = structuredAgentSessionPayloadFingerprint({
      method: 'agentSession.queuedMessageDelete',
      sessionId: 'chat',
      fields: { messageId: operation }
    })
    source
      .prepare(`INSERT INTO agent_session_command_receipts VALUES(?, 'chat', ?,
      'agentSession.queuedMessageDelete', ?, 'accepted', ?, NULL, 100)`)
      .run(
        `delete-${operation}`,
        caller,
        fingerprint,
        JSON.stringify({ kind: 'queued-draft', messageId: operation })
      )
  }
  const current = open(await initializeJournalDomainDatabase(stateDirectory))
  const attempt = { mailbox_handle: 'run:original', message_id: 'mail', session_id: 'chat' }
  expect(readMailWithdrawal(current, { ...attempt, operation_id: 'person-card' }, 'epoch')).toBe(
    'person'
  )
  expect(readMailWithdrawal(current, { ...attempt, operation_id: 'system-card' }, 'epoch')).toBe(
    'system'
  )
  expect(
    readMailWithdrawal(current, { ...attempt, operation_id: 'unattributed-card' }, 'epoch')
  ).toBe('unknown')
})

it('upgrades schema one atomically without trusting old forms or changing source bodies', () => {
  const db = new Database(':memory:')
  cleanup.push(() => db.close())
  db.exec(JOURNAL_DOMAIN_SCHEMA_001.replace('  wire_version INTEGER,\n', ''))
  db.pragma('user_version=1')
  db.exec(`INSERT INTO journal_items(session_id,epoch,item_id,ordinal,revision,sequence,sequence_index,owner_fence,payload_json,placement_json)
    VALUES('chat','epoch','item',0,1,1,0,1,'authoritative source','{}')`)
  const pragma = db.pragma.bind(db)
  const publication = vi.spyOn(db, 'pragma').mockImplementation((sql, ...args) => {
    if (sql === 'user_version = 2') {
      throw new Error('version publication failed')
    }
    return pragma(sql, ...args)
  })
  expect(() => migrateJournalDomainSchema(db)).toThrow('version publication failed')
  publication.mockRestore()
  expect(db.pragma('user_version', { simple: true })).toBe(1)
  expect(() => db.prepare('SELECT wire_version FROM journal_items')).toThrow(/no such column/)
  migrateJournalDomainSchema(db)
  expect(db.pragma('user_version', { simple: true })).toBe(2)
  expect(db.prepare('SELECT payload_json,wire_version FROM journal_items').get()).toEqual({
    payload_json: 'authoritative source',
    wire_version: null
  })
  migrateJournalDomainSchema(db)
  expect(db.prepare('SELECT payload_json,wire_version FROM journal_items').get()).toEqual({
    payload_json: 'authoritative source',
    wire_version: null
  })
})

it('binds the initial profile copy to its source without refreshing an authoritative winner', async () => {
  const root = directory()
  const filename = journalDatabasePath(root)
  const source = new Database(filename)
  source.exec(createJournalTablesSql() + createAgentSessionRecordTablesSql())
  source.pragma('user_version=4')
  source
    .prepare('INSERT INTO agent_session_store_meta VALUES (?, ?)')
    .run(JOURNAL_LEGACY_SOURCE_RECEIPT, 'untrusted legacy value')
  source.close()
  const original = captureJournalLegacySourceReceipt(filename)
  expect(original.disposition).toBe('copied-source')
  const destination = open(await initializeJournalDomainDatabase(root))
  const receipt = () =>
    destination
      .prepare('SELECT value FROM agent_session_store_meta WHERE key=?')
      .get(JOURNAL_LEGACY_SOURCE_RECEIPT)?.value
  expect(JSON.parse(String(receipt()))).toEqual(original)
  const old = new Database(filename)
  old
    .prepare('INSERT INTO agent_session_store_meta VALUES (?, ?)')
    .run('old-build-append', 'history still owed')
  old.close()
  expect(captureJournalLegacySourceReceipt(filename)).not.toEqual(original)
  await initializeJournalDomainDatabase(root)
  expect(JSON.parse(String(receipt()))).toEqual(original)
  expect(
    destination
      .prepare("SELECT value FROM agent_session_store_meta WHERE key='old-build-append'")
      .get()
  ).toBeUndefined()
  const reopened = new Database(filename, { readonly: true })
  expect(
    reopened
      .prepare("SELECT value FROM agent_session_store_meta WHERE key='old-build-append'")
      .get()
  ).toEqual({ value: 'history still owed' })
  reopened.close()
})
