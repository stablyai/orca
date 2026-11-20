// QA seeder (never merged): writes a chat store like a heavy profile after a downgrade into SEED_DIR,
// stopping right before the open that terminal restore waits on.
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openJournalDatabase, runJournalTransaction } from './journal-database'
import { initializeJournalDomainDatabase, openJournalDomainDatabase } from './journal-domain-database'
import { journalDatabasePath } from './journal-host-database'
import { insertJournalRow, publishJournalSessionEpoch } from '../durable-rows/journal-row-table'
import { journalSqlRetryRows } from '../journal-sql-retry-rows.test-fixture'
import { prepareJournalDomainImport } from '../journal-domain-import'
import { finishJournalDomainImport, insertJournalDomainImportPage } from '../journal-domain-import-rows'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import { JournalSqlDatabase } from './journal-sql-database'
import { journalSqlWorkerPath, journalSqlReaderPath } from '../journal-sql-worker-bundle.test-fixture'


const CHATS = Number(process.env.BENCH_CHATS ?? 18000)
const CONTINUED = Number(process.env.BENCH_CONTINUED ?? 7000)
const TURNS = Number(process.env.BENCH_TURNS ?? 40)
const rows = journalSqlRetryRows(false)
type ItemRow = Extract<JournalRow, { kind: 'item' }>
const savedTurn = rows.find((row): row is ItemRow => row.kind === 'item' && row.itemId === 'failed')!
const tip = Math.max(...rows.map((row) => row.seq))
const turn = (itemId: string, seq: number): ItemRow => ({
  ...savedTurn,
  seq,
  itemId,
  body: { kind: 'turn', turnId: itemId, state: 'completed', outcome: 'success' }
})

it('seeds a profile whose next open reconciles an older Orca\'s writes', async () => {
  const root = process.env.SEED_DIR ?? mkdtempSync(join(tmpdir(), 'legacy-stall-'))
  expect(root).toBeTruthy()
  try {
    const { db: original } = openJournalDatabase(journalDatabasePath(root))
    let at = performance.now()
    runJournalTransaction(original, () => {
      for (let index = 0; index < CHATS; index++) {
        const id = `chat-${index}`
        publishJournalSessionEpoch(original, { sessionId: id, workspaceId: `ws-${index % 1900}` }, 'epoch')
        rows.forEach((row) => insertJournalRow(original, id, row))
        for (let t = 0; t < TURNS; t++) {
          insertJournalRow(original, id, turn(`t-${t}`, tip + 1 + t))
        }
        original
          .prepare('INSERT INTO agent_session_records VALUES(?,?)')
          .run(id, JSON.stringify({ sessionId: id, lease: { sessionId: id } }))
        if (index < 175) {
          original.prepare('INSERT INTO agent_session_tabs VALUES(?,?,?)').run(`tab-${id}`, id, index)
        }
      }
    })
    original.prepare("INSERT INTO agent_session_store_meta VALUES('session_tabs_recorded','1')").run()
    original.pragma('wal_checkpoint(TRUNCATE)')
    console.log(`BENCH seed original ${CHATS} chats x ${rows.length + TURNS} rows: ${(performance.now() - at).toFixed(0)} ms`)

    at = performance.now()
    const filename = await initializeJournalDomainDatabase(root)
    console.log(`BENCH first open (upgrade from older Orca): ${(performance.now() - at).toFixed(0)} ms`)

    at = performance.now()
    const { db } = openJournalDomainDatabase(filename)
    for (let index = 0; index < CONTINUED; index++) {
      const imported = prepareJournalDomainImport(original, `chat-${index}`)!
      const { pages, ...header } = imported
      for (const page of pages) {
        runJournalTransaction(db, () => insertJournalDomainImportPage(db, header, page))
      }
      runJournalTransaction(db, () => finishJournalDomainImport(db, header))
    }
    db.close()
    console.log(`BENCH convert ${CONTINUED} chats (setup): ${(performance.now() - at).toFixed(0)} ms`)

    at = performance.now()
    const steady = await initializeJournalDomainDatabase(root)
    console.log(`BENCH steady open, nothing written: ${(performance.now() - at).toFixed(0)} ms`)
    expect(steady).toBe(filename)

    // Downgrade: the older Orca continues every converted chat.
    runJournalTransaction(original, () => {
      for (let index = 0; index < CONTINUED; index++) {
        insertJournalRow(original, `chat-${index}`, turn('older-turn', tip + 1 + TURNS))
      }
    })
    original.pragma('wal_checkpoint(TRUNCATE)')
    original.close()

    console.log(`SEED done in ${root}`)
    const errors: unknown[] = []
    const database = await JournalSqlDatabase.open(root, {
      writerPath: journalSqlWorkerPath(), readerPath: journalSqlReaderPath(),
      onMaintenanceError: (error, id) => { errors.push(error); console.error('ERROR', id, error) }
    })
    const probe = openJournalDomainDatabase(filename).db
    const progress = () => {
      const row = probe.prepare('SELECT COUNT(*) AS total,COUNT(epoch) AS ready FROM journal_chat_state').get()
      console.log('PROGRESS', JSON.stringify({ms: Math.round(performance.now()-at), ...row, readers: database.readers.retention()}))
    }
    at = performance.now()
    const timer = setInterval(progress, 10000)
    try {
      progress()
      await database.startMaintenance()
      progress()
      expect(probe.prepare('SELECT COUNT(*) AS pending FROM journal_chat_state WHERE epoch IS NULL').get()).toEqual({pending: 0})
      expect(errors).toEqual([])
    } finally {
      clearInterval(timer)
      probe.close()
      await database.close()
    }
  } finally {
  }
}, 3_600_000)
