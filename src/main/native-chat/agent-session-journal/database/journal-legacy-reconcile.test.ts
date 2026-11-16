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
import { publishJournalOutcomeEpoch } from '../outcomes/journal-outcome-epoch.test-fixture'
import { persistJournalOutcomeRows } from '../outcomes/journal-outcome-table'
import {
  advanceJournalOutcomeSource,
  journalOutcomeSource
} from '../outcomes/journal-outcome-format'
import { restoreJournal } from '../replay/journal-open'
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

/** An agent reply: what an older Orca adds when someone really uses a chat. */
function reply(itemId: string, seq: number): ItemRow {
  return {
    ...savedTurn,
    seq,
    itemId,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: itemId }] }
  }
}

/** A CI line: what an older Orca adds to a watched chat with no one typing. */
function ciLine(itemId: string, seq: number): ItemRow {
  return {
    ...savedTurn,
    seq,
    itemId,
    body: { kind: 'status', presentation: 'pull-request-event', text: 'Checks passed' }
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
    insertJournalRow(original, 'converted', reply('older-turn', tip + 1))
    insertJournalRow(original, 'unopened', reply('older-unopened-turn', tip + 1))
    insertJournalRow(original, 'closed', reply('older-closed-turn', tip + 1))
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
  ).toEqual({
    sessionId: copy,
    // Its own provider conversation, started on its first send; the original keeps its own.
    providerHandleChain: [],
    lease: {
      sessionId: copy,
      claimStatus: 'released',
      ownerProcess: null,
      reservedSpawnToken: null,
      handoffStage: null,
      handoffOperationId: null,
      provenHandleLinkId: null,
      deathEvidence: null
    }
  })
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
    insertJournalRow(original, 'converted', reply('older-turn', tip + 1))
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
  insertJournalRow(original, 'converted', reply('older-turn', tip + 1))
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
  insertJournalRow(original, 'idle', reply('older-idle-turn', tip + 1))
  await later.close()
  cleanup.pop()
  const again = await upgrade(root)
  cleanup.push(again.close)
  expect(tabbedChats(again.db)).toHaveLength(4)
  expect(again.db.prepare('SELECT COUNT(*) AS records FROM agent_session_records').get()).toEqual({
    records: known.length + 2
  })
})

function record(db: Database.Database, sessionId: string): Record<string, unknown> {
  return JSON.parse(
    String(
      db.prepare('SELECT record_json FROM agent_session_records WHERE session_id=?').get(sessionId)!
        .record_json
    )
  )
}

function saveRecord(db: Database.Database, sessionId: string, fields: Record<string, unknown>) {
  db.prepare('UPDATE agent_session_records SET record_json=? WHERE session_id=?').run(
    JSON.stringify({ ...record(db, sessionId), ...fields }),
    sessionId
  )
}

it('takes only bookkeeping an older Orca wrote as the new baseline, with the renames made there', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-reconcile-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: original } = openJournalDatabase(journalDatabasePath(root))
  cleanup.push(() => original.close())
  for (const id of ['watched', 'renamed-there', 'renamed-here']) {
    olderOrcaChat(original, id, rows)
    saveRecord(original, id, { conversationName: id, updatedAt: 100 })
  }
  const first = await upgrade(root)
  expect(await first.convert('watched')).toBe('epoch')
  saveRecord(first.db, 'renamed-here', {
    conversationName: 'Named here',
    conversationNameSource: 'user',
    updatedAt: 200
  })
  const tabs = tabbedChats(first.db)
  await first.close()

  // The older Orca adds CI lines with no one typing, settles leases at launch, and a person renames one.
  runJournalTransaction(original, () => {
    insertJournalRow(original, 'watched', ciLine('ci-watched', tip + 1))
    // An open sets a send it never handed over back as a queued card with the send's own text.
    const send = rows.find((row) => row.kind === 'submission')!
    insertJournalRow(original, 'watched', {
      ...rows.find((row) => row.kind === 'queue')!,
      kind: 'queue',
      seq: tip + 2,
      messageId: send.clientMessageId,
      change: {
        op: 'queued',
        body: send.body,
        position: 1,
        queuedAt: { epoch: 'epoch', sequence: send.seq }
      }
    })
    insertJournalRow(original, 'renamed-here', ciLine('ci-renamed-here', tip + 1))
    // Launch-time lease settlement stamps `updatedAt` on every record it touches.
    saveRecord(original, 'renamed-here', {
      lease: { sessionId: 'renamed-here', lastRenewedAt: 300 },
      updatedAt: 300
    })
    saveRecord(original, 'renamed-there', {
      conversationName: 'Named there',
      conversationNameSource: 'user',
      updatedAt: 300
    })
  })
  const later = await upgrade(root)
  cleanup.push(later.close)
  expect(
    later.db
      .prepare('SELECT session_id FROM agent_session_records ORDER BY session_id')
      .all()
      .map((row) => String(row.session_id))
  ).toEqual(['renamed-here', 'renamed-there', 'watched'])
  expect(tabbedChats(later.db)).toEqual(tabs)
  expect(record(later.db, 'renamed-here')).toMatchObject({ conversationName: 'Named here' })
  expect(record(later.db, 'renamed-there')).toMatchObject({
    conversationName: 'Named there',
    conversationNameSource: 'user'
  })
  expect(items(later.db, 'watched')).not.toContain('ci-watched')
})

it('keeps a message an older Orca rewrote at a revision this file also reached', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-reconcile-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: original } = openJournalDatabase(journalDatabasePath(root))
  cleanup.push(() => original.close())
  olderOrcaChat(original, 'diverged', [...rows, reply('answer', tip + 1)])
  const first = await upgrade(root)
  expect(await first.convert('diverged')).toBe('epoch')
  // This file revised the answer; with no revision kept, only the item's own revision is left.
  first.db
    .prepare(`UPDATE journal_items SET revision=2,
      payload_json=json_set(payload_json,'$.revision',2,'$.body.blocks[0].text','here')
      WHERE session_id='diverged' AND item_id='answer'`)
    .run()
  asOlderChatStore(first.db)
  await first.close()

  insertJournalRow(original, 'diverged', {
    ...reply('answer', tip + 2),
    revision: 2,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'older' }] }
  })
  const later = await upgrade(root)
  cleanup.push(later.close)
  const [copy] = later.db
    .prepare("SELECT session_id FROM agent_session_records WHERE session_id!='diverged'")
    .all()
    .map((row) => String(row.session_id))
  expect(
    later.db
      .prepare(`SELECT json_extract(payload_json,'$.body.blocks[0].text') AS text FROM journal_items
        WHERE session_id=? AND item_id='answer'`)
      .get(copy!)
  ).toEqual({ text: 'older' })
})

it('keeps a reply and queued text an older Orca saved as outcome records, not a CI line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-reconcile-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: original } = openJournalDatabase(journalDatabasePath(root))
  cleanup.push(() => original.close())
  const saved = journalSqlRetryRows(true)
  const end = saved.length
  const chats = ['replied', 'queued', 'watched']
  runJournalTransaction(original, () => {
    for (const id of chats) {
      publishJournalSessionEpoch(original, { sessionId: id, workspaceId: 'workspace' }, 'epoch')
      publishJournalOutcomeEpoch(original, id, 'epoch', saved)
      original
        .prepare('INSERT INTO agent_session_records VALUES(?,?)')
        .run(id, JSON.stringify({ sessionId: id, lease: { sessionId: id } }))
    }
  })
  const first = await upgrade(root)
  for (const id of chats) {
    expect(await first.convert(id)).toBe('epoch')
  }
  await first.close()

  const queuedLater: JournalRow = {
    ...saved.find((row) => row.kind === 'queue')!,
    kind: 'queue',
    messageId: 'later',
    seq: end + 1,
    change: {
      op: 'queued',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'later' }] },
      position: 2,
      queuedAt: { epoch: 'epoch', sequence: end }
    }
  }
  // As an older Orca appends: one outcome record past the coverage this file read.
  const append = (id: string, row: JournalRow) => {
    const { state } = restoreJournal(original, id)!
    const written = persistJournalOutcomeRows(
      original,
      state,
      journalOutcomeSource(original, id, 'epoch')!,
      [row]
    )
    advanceJournalOutcomeSource(original, id, 'epoch', written.state.lastSequence)
  }
  runJournalTransaction(original, () => {
    append('replied', reply('older-reply', end + 1))
    append('queued', queuedLater)
    append('watched', ciLine('ci', end + 1))
  })
  const later = await upgrade(root)
  cleanup.push(later.close)
  const copies = later.db
    .prepare('SELECT session_id FROM agent_session_records WHERE session_id NOT IN (?,?,?)')
    .all(...chats)
    .map((row) => String(row.session_id))
  expect(copies).toHaveLength(2)
  expect(copies.flatMap((copy) => items(later.db, copy))).toContain('older-reply')
  expect(
    later.db
      .prepare(`SELECT session_id FROM journal_queue_cards WHERE message_id='later'`)
      .all()
      .map((row) => String(row.session_id))
  ).toEqual(copies.filter((copy) => !items(later.db, copy).includes('older-reply')))
})
