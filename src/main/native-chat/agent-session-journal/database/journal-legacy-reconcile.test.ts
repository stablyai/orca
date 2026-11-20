import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type Database from '../../../sqlite/sync-database'
import { openJournalDatabase, runJournalTransaction } from './journal-database'
import {
  initializeJournalDomainDatabase,
  openJournalDomainDatabase
} from './journal-domain-database'
import { journalDatabasePath, journalDomainDatabasePath } from './journal-host-database'
import { insertJournalRow, publishJournalSessionEpoch } from '../durable-rows/journal-row-table'
import { journalSqlRetryRows } from '../journal-sql-retry-rows.test-fixture'
import { JournalSqlReaderPool } from '../journal-sql-reader-pool'
import { JournalSqlConversions } from '../journal-sql-conversions'
import { journalSqlReaderPath } from '../journal-sql-worker-bundle.test-fixture'
import { applyJournalSqlMaintenance } from '../journal-sql-maintenance'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import { AGENT_SESSION_JOURNAL_QUEUE_SCHEMA_VERSION } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { readJournalSqlDatabase } from '../journal-sql-database-read'

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
    /** One background pass over converted chats awaiting a compare, as maintenance runs it. */
    compare: async () => {
      const page = await pool.database({ kind: 'legacy-compares', after: null })
      for (const compare of page.kind === 'legacy-compares' ? page.compares : []) {
        const result = await pool.compareLegacyChat(compare.sessionId)
        runJournalTransaction(db, () =>
          applyJournalSqlMaintenance(db, { kind: 'legacy-compare-settle', ...compare, ...result! })
        )
      }
    },
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

  const second = await upgrade(root)
  cleanup.push(second.close)
  const { db } = second
  expect(items(db, 'converted')).toEqual(converted)
  const [copy] = db
    .prepare(`SELECT session_id FROM agent_session_records
      WHERE session_id NOT IN ('converted','unopened','started-older','closed')`)
    .all()
    .map((row) => String(row.session_id))
  // Terminal restore waits for the open, so the copy's history converts later, from the original.
  expect(items(db, copy)).toEqual([])
  expect(await second.convert(copy)).toBe('epoch')
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
  await (await upgrade(root)).close()

  // Written twice more before the copy converted: that copy reads the current original, so no second.
  for (const [index, itemId] of ['older-turn-2', 'older-turn-3'].entries()) {
    runJournalTransaction(original, () => {
      insertJournalRow(original, 'converted', turn(itemId, tip + 2 + index))
    })
    original.pragma('wal_checkpoint(TRUNCATE)')
    if (index === 0) {
      await (await upgrade(root)).close()
    }
  }
  const later = await upgrade(root)
  cleanup.push(later.close)
  const copies = later.db
    .prepare("SELECT session_id FROM agent_session_records WHERE session_id!='converted'")
    .all()
    .map((row) => String(row.session_id))
  expect(copies).toHaveLength(1)
  expect(await later.convert(copies[0]!)).toBe('epoch')
  expect(items(later.db, copies[0]!)).toEqual(
    expect.arrayContaining(['older-turn', 'older-turn-2', 'older-turn-3'])
  )
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
  const known = ['closed', 'converted', 'idle', 'open', 'started-older']
  const compared = await upgrade(root)
  // With no revision to compare, the open reads no history; a background pass compares it.
  expect(
    compared.db.prepare('SELECT COUNT(*) AS records FROM agent_session_records').get()
  ).toEqual({ records: known.length })
  await compared.compare()
  await compared.close()
  const later = await upgrade(root)
  cleanup.push(later.close)
  const [copy] = later.db
    .prepare(
      `SELECT session_id FROM agent_session_records WHERE session_id NOT IN (${known
        .map(() => '?')
        .join(',')})`
    )
    .all(...known)
    .map((row) => String(row.session_id))
  expect(await later.convert(copy!)).toBe('epoch')
  expect(items(later.db, copy!)).toContain('older-turn')
  expect(tabbedChats(later.db)).toEqual(['open', 'started-older', copy])
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

it('keeps a message an older Orca queued in a chat from before revisions were kept', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-reconcile-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: original } = openJournalDatabase(journalDatabasePath(root))
  cleanup.push(() => original.close())
  olderOrcaChat(original, 'queued', rows)
  const first = await upgrade(root)
  expect(await first.convert('queued')).toBe('epoch')
  asOlderChatStore(first.db)
  await first.close()

  insertJournalRow(original, 'queued', {
    v: AGENT_SESSION_JOURNAL_QUEUE_SCHEMA_VERSION,
    epoch: 'epoch',
    seq: tip + 1,
    ts: 100,
    fence: 1,
    kind: 'queue',
    messageId: 'older-queued',
    change: {
      op: 'queued',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'later' }] },
      position: 1,
      queuedAt: null
    }
  })
  const compared = await upgrade(root)
  await compared.compare()
  await compared.close()
  const later = await upgrade(root)
  cleanup.push(later.close)
  const copy = later.db
    .prepare("SELECT session_id FROM agent_session_records WHERE session_id!='queued'")
    .get()?.session_id
  expect(await later.convert(String(copy))).toBe('epoch')
  expect(
    later.db
      .prepare('SELECT message_id FROM journal_queue_cards WHERE session_id=?')
      .all(String(copy))
  ).toContainEqual({ message_id: 'older-queued' })
})

it('records a chat it cannot keep and does not retry it until the older Orca writes it again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-reconcile-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: original } = openJournalDatabase(journalDatabasePath(root))
  cleanup.push(() => original.close())
  olderOrcaChat(original, 'kept', rows)
  await (await upgrade(root)).close()
  olderOrcaChat(original, 'refused', [rows[0], turn('refused-turn', 2)])
  original.pragma('wal_checkpoint(TRUNCATE)')

  const blocked = openJournalDomainDatabase(journalDomainDatabasePath(root)).db
  blocked.exec(`CREATE TRIGGER refused BEFORE INSERT ON agent_session_records
    WHEN NEW.session_id='refused' BEGIN SELECT RAISE(ABORT,'record refused'); END`)
  blocked.close()
  const failing = openJournalDomainDatabase(await initializeJournalDomainDatabase(root)).db
  const recorded = (key: string) =>
    failing.prepare('SELECT value FROM agent_session_store_meta WHERE key=?').get(key)?.value
  expect(JSON.parse(String(recorded('journal.legacy-failed:refused')))).toMatchObject({
    error: expect.stringContaining('record refused')
  })
  expect(recorded('journal.legacy-revisions-kept.v1')).toBe('1')
  failing.exec('DROP TRIGGER refused')
  failing.close()

  const refusedRecord = (db: Database.Database) =>
    db.prepare("SELECT 1 FROM agent_session_records WHERE session_id='refused'").get()
  const absorbed = await upgrade(root)
  expect(refusedRecord(absorbed.db)).toBeUndefined()
  await absorbed.close()

  insertJournalRow(original, 'refused', turn('refused-turn-2', 3))
  original.pragma('wal_checkpoint(TRUNCATE)')
  const retried = await upgrade(root)
  cleanup.push(retried.close)
  expect(refusedRecord(retried.db)).toEqual({ 1: 1 })
})

it('keeps a fresh copy when another build readied a copy before its history converted here', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-reconcile-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: original } = openJournalDatabase(journalDatabasePath(root))
  cleanup.push(() => original.close())
  olderOrcaChat(original, 'converted', rows)
  const first = await upgrade(root)
  expect(await first.convert('converted')).toBe('epoch')
  await first.close()
  insertJournalRow(original, 'converted', turn('older-turn', tip + 1))
  original.pragma('wal_checkpoint(TRUNCATE)')

  const copied = await upgrade(root)
  const copies = (db: Database.Database) =>
    db
      .prepare("SELECT session_id FROM agent_session_records WHERE session_id!='converted'")
      .all()
      .map((row) => String(row.session_id))
  const [stranded] = copies(copied.db)
  // An older build that can't read the copy's source founds it empty, as a new chat.
  copied.db
    .prepare(
      "INSERT INTO journal_chat_state(workspace_id,session_id,epoch) VALUES('workspace',?,'founded') ON CONFLICT(session_id) DO UPDATE SET epoch='founded'"
    )
    .run(stranded!)
  await copied.close()

  const again = await upgrade(root)
  cleanup.push(again.close)
  const kept = copies(again.db).find((id) => id !== stranded)
  expect(copies(again.db)).toHaveLength(2)
  expect(await again.convert(kept!)).toBe('epoch')
  expect(items(again.db, kept!)).toContain('older-turn')
})

it('leaves a copy whose history failed to convert to an open, not to every idle pass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-reconcile-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: original } = openJournalDatabase(journalDatabasePath(root))
  cleanup.push(() => original.close())
  olderOrcaChat(original, 'converted', rows)
  const first = await upgrade(root)
  expect(await first.convert('converted')).toBe('epoch')
  await first.close()
  insertJournalRow(original, 'converted', turn('older-turn', tip + 1))
  original.pragma('wal_checkpoint(TRUNCATE)')
  const later = await upgrade(root)
  cleanup.push(later.close)
  const { db } = later
  const [copy] = db
    .prepare("SELECT session_id FROM agent_session_records WHERE session_id!='converted'")
    .all()
    .map((row) => String(row.session_id))
  const idle = () => {
    const page = readJournalSqlDatabase(db, { kind: 'sessions', after: null })
    return page.kind === 'sessions' ? page.sessionIds : []
  }
  expect(idle()).toContain(copy)

  for (const sessionId of [copy!, 'converted']) {
    runJournalTransaction(db, () =>
      applyJournalSqlMaintenance(db, { kind: 'legacy-copy-failed', sessionId, error: 'damaged' })
    )
  }
  expect(idle()).not.toContain(copy)
  expect(idle()).toContain('converted')

  expect(await later.convert(copy!)).toBe('epoch')
  expect(items(db, copy!)).toContain('older-turn')
  expect(
    db
      .prepare('SELECT 1 FROM agent_session_store_meta WHERE key=?')
      .get(`journal.legacy-failed:${copy}`)
  ).toBeUndefined()
})
