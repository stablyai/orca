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

const savedTurn = rows.find((row) => row.kind === 'item' && row.itemId === 'failed')!
const tip = Math.max(...rows.map((row) => row.seq))

function turn(itemId: string, seq: number): JournalRow {
  return {
    ...savedTurn,
    seq,
    itemId,
    body: { kind: 'turn', turnId: itemId, state: 'completed', outcome: 'success' }
  } as JournalRow
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
  await first.close()

  runJournalTransaction(original, () => {
    insertJournalRow(original, 'converted', turn('older-turn', tip + 1))
    insertJournalRow(original, 'unopened', turn('older-unopened-turn', tip + 1))
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
      WHERE session_id NOT IN ('converted','unopened','started-older')`)
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
  ).toEqual([copy, 'converted', 'started-older', 'unopened'])
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
    records: 4
  })
})
