import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type Database from '../../../sqlite/sync-database'
import { openJournalDatabase, runJournalTransaction } from './journal-database'
import {
  initializeJournalDomainDatabase,
  journalDomainDatabasePath,
  openJournalDomainDatabase
} from './journal-domain-database'
import { journalDatabasePath } from './journal-host-database'
import { insertJournalRow, publishJournalSessionEpoch } from '../durable-rows/journal-row-table'
import { journalSqlRetryRows } from '../journal-sql-retry-rows.test-fixture'
import { JournalSqlReaderPool } from '../journal-sql-reader-pool'
import { JournalSqlConversions } from '../journal-sql-conversions'
import { journalSqlReaderPath } from '../journal-sql-worker-bundle.test-fixture'
import { applyJournalSqlMaintenance } from '../journal-sql-maintenance'
import type { JournalRow } from '../durable-rows/journal-row-schema'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
})

const rows = journalSqlRetryRows(false)

type ItemRow = Extract<JournalRow, { kind: 'item' }>
const savedTurn = rows.find(
  (row): row is ItemRow => row.kind === 'item' && row.itemId === 'failed'
)!
const tip = Math.max(...rows.map((row) => row.seq))

function turn(itemId: string, seq: number): ItemRow {
  return {
    ...savedTurn,
    seq,
    itemId,
    body: { kind: 'turn', turnId: itemId, state: 'completed', outcome: 'success' }
  }
}

/** An older Orca's writable open, adding a chat with its record, tab and saved history. */
function olderOrcaChat(original: Database.Database, sessionId: string, history: JournalRow[]) {
  runJournalTransaction(original, () => {
    publishJournalSessionEpoch(original, { sessionId, workspaceId: 'workspace' }, 'epoch')
    history.forEach((row) => insertJournalRow(original, sessionId, row))
    original
      .prepare('INSERT INTO agent_session_records VALUES(?,?)')
      .run(sessionId, JSON.stringify({ sessionId, lease: { sessionId } }))
    original
      .prepare('INSERT INTO agent_session_tabs VALUES(?,?,?)')
      .run(`tab-${sessionId}`, sessionId, 0)
  })
}

async function upgrade(root: string) {
  const filename = await initializeJournalDomainDatabase(root)
  const { db } = openJournalDomainDatabase(filename)
  const pool = new JournalSqlReaderPool(filename, journalDatabasePath(root), journalSqlReaderPath())
  const conversions = new JournalSqlConversions(
    {
      maintain: async (operation) =>
        runJournalTransaction(db, () => applyJournalSqlMaintenance(db, operation))
    },
    pool,
    async () => {}
  )
  return {
    db,
    convert: (sessionId: string) => conversions.ensure(sessionId),
    close: async () => {
      await conversions.close()
      await pool.close()
      db.close()
    }
  }
}

function items(db: Database.Database, sessionId: string): string[] {
  return db
    .prepare('SELECT item_id FROM journal_items WHERE session_id=? ORDER BY ordinal')
    .all(sessionId)
    .map((row) => String(row.item_id))
}

it('keeps every chat and turn an older Orca saved after a downgrade, without changing either side', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-reconcile-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: original } = openJournalDatabase(journalDatabasePath(root))
  cleanup.push(() => original.close())
  olderOrcaChat(original, 'converted', rows)
  olderOrcaChat(original, 'unopened', rows)
  olderOrcaChat(original, 'closed', rows)
  original
    .prepare('INSERT INTO agent_session_records VALUES(?,?)')
    .run('empty', JSON.stringify({ sessionId: 'empty', lease: { sessionId: 'empty' } }))

  // Upgrade: one chat converts, then the user goes back to the older Orca.
  const first = await upgrade(root)
  expect(await first.convert('converted')).toBe('epoch')
  const converted = items(first.db, 'converted')
  // Deleted here before the downgrade, then continued in the older Orca.
  first.db.prepare("DELETE FROM agent_session_records WHERE session_id='unopened'").run()
  first.db.prepare("DELETE FROM agent_session_tabs WHERE session_id='unopened'").run()
  first.db.prepare("DELETE FROM agent_session_records WHERE session_id='empty'").run()
  // Closed here (record kept), then continued in the older Orca.
  first.db.prepare("DELETE FROM agent_session_tabs WHERE session_id='closed'").run()
  await first.close()

  runJournalTransaction(original, () => {
    insertJournalRow(original, 'converted', turn('older-turn', tip + 1))
    insertJournalRow(original, 'unopened', turn('older-unopened-turn', tip + 1))
    insertJournalRow(original, 'closed', turn('older-closed-turn', tip + 1))
    original
      .prepare('INSERT INTO agent_session_attachment_claims VALUES(?,?,?)')
      .run('older-upload', 'converted', 100)
  })
  olderOrcaChat(original, 'started-older', [rows[0], turn('started-turn', 2)])
  original.pragma('wal_checkpoint(TRUNCATE)')
  const originalBytes = createHash('sha256')
    .update(readFileSync(journalDatabasePath(root)))
    .digest('hex')

  // Upgrade again; one chat fails to join the first time and joins on the next launch.
  const blocked = openJournalDomainDatabase(journalDomainDatabasePath(root)).db
  blocked.exec(`CREATE TRIGGER blocked BEFORE INSERT ON agent_session_records
    WHEN NEW.session_id='started-older' BEGIN SELECT RAISE(ABORT,'disk full'); END`)
  blocked.close()
  const failing = openJournalDomainDatabase(await initializeJournalDomainDatabase(root)).db
  expect(
    failing.prepare("SELECT 1 FROM agent_session_records WHERE session_id='started-older'").get()
  ).toBeUndefined()
  failing.exec('DROP TRIGGER blocked')
  failing.close()
  const second = await upgrade(root)
  cleanup.push(second.close)
  const { db } = second
  expect(items(db, 'converted')).toEqual(converted)
  const [copy] = db
    .prepare(`SELECT session_id FROM agent_session_records
      WHERE session_id NOT IN ('converted','unopened','started-older','closed')`)
    .all()
    .map((row) => String(row.session_id))
  expect(items(db, copy)).toEqual([...converted, 'older-turn'])
  expect(
    JSON.parse(
      String(
        db.prepare('SELECT record_json FROM agent_session_records WHERE session_id=?').get(copy)!
          .record_json
      )
    )
  ).toEqual({ sessionId: copy, lease: { sessionId: copy } })
  expect(
    db
      .prepare('SELECT session_id FROM agent_session_tabs')
      .all()
      .map((row) => String(row.session_id))
      .toSorted()
  ).toEqual([copy, 'closed', 'converted', 'started-older', 'unopened'].toSorted())
  expect(await second.convert('started-older')).toBe('epoch')
  expect(items(db, 'started-older')).toEqual(['started-turn'])
  expect(await second.convert('unopened')).toBe('epoch')
  expect(items(db, 'unopened')).toContain('older-unopened-turn')
  expect(
    db
      .prepare('SELECT session_id FROM agent_session_attachment_claims WHERE upload_id=?')
      .all('older-upload')
      .map((row) => String(row.session_id))
      .toSorted()
  ).toEqual([copy, 'converted'].toSorted())
  expect(
    createHash('sha256')
      .update(readFileSync(journalDatabasePath(root)))
      .digest('hex')
  ).toBe(originalBytes)

  expect(
    db.prepare("SELECT 1 FROM agent_session_records WHERE session_id='empty'").get()
  ).toBeUndefined()
  // A later launch with nothing new written keeps exactly one copy.
  await second.close()
  cleanup.pop()
  const third = await upgrade(root)
  cleanup.push(third.close)
  expect(third.db.prepare('SELECT COUNT(*) AS records FROM agent_session_records').get()).toEqual({
    records: 5
  })
})

it('fills in revisions for chats converted before they were kept, then still keeps later turns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-reconcile-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: original } = openJournalDatabase(journalDatabasePath(root))
  cleanup.push(() => original.close())
  olderOrcaChat(original, 'converted', rows)
  original.pragma('wal_checkpoint(TRUNCATE)')
  const first = await upgrade(root)
  expect(await first.convert('converted')).toBe('epoch')
  // As a build from before revisions were kept left it.
  first.db.exec(`DELETE FROM agent_session_store_meta WHERE key LIKE 'journal.legacy-revision%'`)
  await first.close()

  const unchanged = await upgrade(root)
  expect(unchanged.db.prepare('SELECT session_id FROM agent_session_records').all()).toEqual([
    { session_id: 'converted' }
  ])
  await unchanged.close()

  runJournalTransaction(original, () => {
    insertJournalRow(original, 'converted', turn('older-turn', tip + 1))
  })
  original.pragma('wal_checkpoint(TRUNCATE)')
  const later = await upgrade(root)
  cleanup.push(later.close)
  const copies = later.db
    .prepare("SELECT session_id FROM agent_session_records WHERE session_id!='converted'")
    .all()
    .map((row) => String(row.session_id))
  expect(copies).toHaveLength(1)
  expect(items(later.db, copies[0]!)).toContain('older-turn')
  expect(
    later.db
      .prepare("SELECT value FROM agent_session_store_meta WHERE key='session_tabs_recorded'")
      .get()
  ).toEqual({ value: '1' })
})

/** As a build from before revisions were kept left the file: no baselines, receipt without WAL identity. */
function asOlderChatStore(db: Database.Database): void {
  db.exec(`DELETE FROM agent_session_store_meta
    WHERE key LIKE 'journal.legacy-revision%' OR key = 'journal.legacy-revisions-kept.v1'`)
  db.prepare(`UPDATE agent_session_store_meta SET value=json_remove(value,'$.wal.ino','$.wal.mtimeNs')
    WHERE key='journal.legacy-source-copy.v1'`).run()
}

function tabbedChats(db: Database.Database): string[] {
  return db
    .prepare('SELECT session_id FROM agent_session_tabs ORDER BY position')
    .all()
    .map((row) => String(row.session_id))
}

it('keeps closed chats closed and adds no copies when a file from before revisions were kept upgrades', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-reconcile-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: original } = openJournalDatabase(journalDatabasePath(root))
  cleanup.push(() => original.close())
  for (let index = 0; index < 100; index += 1) {
    olderOrcaChat(original, `chat-${index}`, rows)
  }
  original.prepare("DELETE FROM agent_session_tabs WHERE session_id!='chat-0'").run()
  const first = await upgrade(root)
  expect(await first.convert('chat-1')).toBe('epoch')
  asOlderChatStore(first.db)
  // As in the reported profile, the copy saw the original's WAL, recorded by its size alone.
  const receipt = first.db
    .prepare('SELECT value FROM agent_session_store_meta WHERE key=?')
    .get('journal.legacy-source-copy.v1')!
  expect(JSON.parse(String(receipt.value)).wal).toEqual({
    kind: 'nonempty',
    size: expect.any(String)
  })
  await first.close()

  // The original stays open with its WAL unchanged: nothing was written since the copy.
  const unchanged = await upgrade(root)
  expect(tabbedChats(unchanged.db)).toEqual(['chat-0'])
  expect(
    unchanged.db.prepare('SELECT COUNT(*) AS records FROM agent_session_records').get()
  ).toEqual({ records: 100 })
  await unchanged.close()
})

it('keeps only what an older Orca wrote after a file from before revisions were kept copied it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-reconcile-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: original } = openJournalDatabase(journalDatabasePath(root))
  cleanup.push(() => original.close())
  olderOrcaChat(original, 'open', rows)
  olderOrcaChat(original, 'closed', rows)
  olderOrcaChat(original, 'idle', rows)
  olderOrcaChat(original, 'converted', rows)
  original
    .prepare('INSERT INTO agent_session_records VALUES(?,?)')
    .run('empty', JSON.stringify({ sessionId: 'empty', lease: { sessionId: 'empty' } }))
  original.prepare("DELETE FROM agent_session_tabs WHERE session_id!='open'").run()
  // As every older Orca that saves tabs leaves its index.
  original.prepare("INSERT INTO agent_session_store_meta VALUES('session_tabs_recorded','1')").run()
  const first = await upgrade(root)
  expect(await first.convert('idle')).toBe('epoch')
  expect(await first.convert('converted')).toBe('epoch')
  // Deleted here: a chat with no history the older Orca didn't write stays deleted.
  first.db.prepare("DELETE FROM agent_session_records WHERE session_id='empty'").run()
  asOlderChatStore(first.db)
  await first.close()

  // The older Orca continues one converted chat and starts another.
  insertJournalRow(original, 'converted', turn('older-turn', tip + 1))
  olderOrcaChat(original, 'started-older', [rows[0], turn('started-turn', 2)])
  const later = await upgrade(root)
  cleanup.push(later.close)
  const known = ['closed', 'converted', 'idle', 'open', 'started-older']
  const [copy] = later.db
    .prepare(
      `SELECT session_id FROM agent_session_records WHERE session_id NOT IN (${known
        .map(() => '?')
        .join(',')})`
    )
    .all(...known)
    .map((row) => String(row.session_id))
  expect(items(later.db, copy!)).toContain('older-turn')
  expect(tabbedChats(later.db)).toEqual(['open', copy, 'started-older'])
  expect(later.db.prepare('SELECT COUNT(*) AS records FROM agent_session_records').get()).toEqual({
    records: known.length + 1
  })

  // Baselines now exist, so a later write by the older Orca is still kept, and nothing else moves.
  insertJournalRow(original, 'idle', turn('older-idle-turn', tip + 1))
  await later.close()
  cleanup.pop()
  const again = await upgrade(root)
  cleanup.push(again.close)
  expect(tabbedChats(again.db)).toHaveLength(4)
  expect(again.db.prepare('SELECT COUNT(*) AS records FROM agent_session_records').get()).toEqual({
    records: known.length + 2
  })
})
