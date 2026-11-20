import { existsSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { journalDomainImportState } from './journal-domain-import-rows'
import { initializeJournalDomainDatabase } from './database/journal-domain-database'
import {
  cleanup,
  continueInOlderOrca,
  fakeLease,
  olderOrcaChat,
  profile
} from './journal-legacy-retirement.test-fixture'
import { JournalLegacyIneligibleError } from './journal-legacy-retention-error'
import { setLegacyJournalRetirementHost } from './journal-legacy-retirement-outcome'
import { readLegacyProofSessions } from './journal-legacy-content-proof'
import { v1_4_219Journal } from './journal-legacy-v1-4-219.test-fixture'
import { readJournalLegacySourceReceipt } from './database/journal-legacy-source-receipt'
import { legacyDestinationMain } from './journal-legacy-retirement-files'
import { journalDomainDatabasePath } from './database/journal-host-database'

function rename(filename: string, sessionId: string, name: string) {
  const db = new Database(filename)
  db.prepare(
    `UPDATE agent_session_records SET record_json=json_set(record_json,
    '$.conversationName',?,'$.conversationNameSource','user') WHERE session_id=?`
  ).run(name, sessionId)
  db.close()
}

function queue(filename: string, sessionId: string, text: string) {
  const db = new Database(filename)
  db.prepare(
    `INSERT INTO queued_messages
    (session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state)
    VALUES(?,?,?,?,?,?,?,?)`
  ).run(
    sessionId,
    'queued-after-copy',
    1,
    JSON.stringify({
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text }]
    }),
    'fingerprint',
    1000,
    'older-host',
    'waiting'
  )
  db.close()
}

/** Every original version kept here for a chat, oldest key first. */
const originals = (db: Database.Database, sessionId: string) =>
  db
    .prepare('SELECT value FROM agent_session_store_meta WHERE key LIKE ? ORDER BY key')
    .all(`journal.legacy-original:${sessionId}:%`)
    .map((row) => JSON.parse(String(row.value)))

const original = (db: Database.Database, sessionId: string) => originals(db, sessionId)[0] ?? null

const companions = (filename: string) =>
  [filename, `${filename}-wal`, `${filename}-shm`].filter((name) => existsSync(name))

function tabsAndRecords(db: Database.Database) {
  return {
    tabs: db
      .prepare('SELECT tab_id,session_id,position FROM agent_session_tabs ORDER BY tab_id')
      .all(),
    records: db.prepare('SELECT session_id FROM agent_session_records ORDER BY session_id').all()
  }
}

it('retires the converted original and clears leftover WAL and SHM on a later launch', async () => {
  const { root, filename, db, launch, errors } = await profile()
  writeFileSync(`${filename}-shm`, '')
  expect(journalDomainImportState(db, 'unopened').state).toBe('converting')

  await launch().run()

  expect(errors).toEqual([])
  expect(companions(filename)).toEqual([])
  expect(journalDomainImportState(db, 'unopened').state).toBe('ready')
  expect(
    db.prepare('SELECT COUNT(*) AS n FROM journal_items WHERE session_id=?').get('unopened')!.n
  ).toBeGreaterThan(0)
  const before = tabsAndRecords(db)
  // The next launch's older-Orca pass sees no original: no rescan, no tab or record change.
  await initializeJournalDomainDatabase(root)
  expect(tabsAndRecords(db)).toEqual(before)
  writeFileSync(`${filename}-wal`, '')
  writeFileSync(`${filename}-shm`, 'index')
  await launch().run()
  expect(errors).toEqual([])
  expect(companions(filename)).toEqual([])
  expect(tabsAndRecords(db)).toEqual(before)
})

it('keeps the original whenever the store cannot prove it holds all of it', async () => {
  // The version that copied the profile keeps it until an update.
  const same = await profile({ copiedBy: '1.0.1' })
  await same.launch('1.0.1').run()
  expect(companions(same.filename)).toContain(same.filename)

  // So does an older version, after a downgrade.
  const older = await profile()
  await older.launch('0.9.0').run()
  expect(companions(older.filename)).toContain(older.filename)

  // A launch that doesn't own the profile never deletes.
  const foreign = await profile()
  await foreign.launch('1.0.1', false).run()
  expect(companions(foreign.filename)).toContain(foreign.filename)

  // Content the proof can't account for is refused, and the refusal is not re-proven.
  // The smallest possible key is still read: an empty session id sorts before every other.
  const orphan = await profile({
    seed: (legacy) =>
      legacy.exec("INSERT INTO journal_rows VALUES('','',1,1,'unaccounted user text')")
  })
  await orphan.launch().run()
  expect(companions(orphan.filename)).toContain(orphan.filename)
  expect(
    JSON.parse(
      String(
        orphan.db
          .prepare(
            "SELECT value FROM agent_session_store_meta WHERE key='journal.legacy-retirement.v2'"
          )
          .get()!.value
      )
    )
  ).toMatchObject({ phase: 'refused', reason: 'source-orphan' })

  // History an older Orca added to a converted chat without a record (as every chat in a journal
  // from before records is): no pass absorbs it.
  const unrecorded = await profile()
  await unrecorded.convert('unopened')
  const legacy = new Database(unrecorded.filename)
  legacy.exec(`DELETE FROM agent_session_records WHERE session_id='unopened';
    INSERT INTO journal_rows SELECT session_id,epoch,seq+1,ts,row_json FROM journal_rows
      WHERE session_id='unopened' ORDER BY seq DESC LIMIT 1`)
  legacy.close()
  await initializeJournalDomainDatabase(unrecorded.root)
  await unrecorded.launch().run()
  expect(companions(unrecorded.filename)).toContain(unrecorded.filename)
  expect(String(unrecorded.errors.at(-1))).toContain('history this store lacks')
})

it('after a downgrade to an older Orca, the re-upgrade takes its new chat and then retires that journal too', async () => {
  const { root, filename, db, launch } = await profile()
  await launch().run()
  expect(existsSync(filename)).toBe(false)
  const before = tabsAndRecords(db).records.length

  // The older Orca finds no journal, starts a new one and saves one chat in it.
  olderOrcaChat(filename, 'made-after-downgrade')
  await initializeJournalDomainDatabase(root)
  expect(tabsAndRecords(db).records.length).toBe(before + 1)

  // Once the reconcile took that chat, the store holds everything the new journal has.
  await launch('1.0.2').run()
  expect(companions(filename)).toEqual([])
  expect(journalDomainImportState(db, 'made-after-downgrade').state).toBe('ready')
})

it('retires a store from its content, keeping chats deleted here deleted', async () => {
  // A chat deleted here is not converted back from the original, and doesn't block retirement.
  const deleted = await profile()
  deleted.db.exec("DELETE FROM agent_session_records WHERE session_id='unopened'")
  deleted.db.exec("DELETE FROM journal_chat_state WHERE session_id='unopened'")
  await deleted.launch().run()
  expect(companions(deleted.filename)).toEqual([])
  expect(
    deleted.db.prepare("SELECT 1 FROM journal_chat_state WHERE session_id='unopened'").get()
  ).toBeUndefined()

  // An upload the original claims for a kept chat stays claimed here once the original goes.
  const claimed = await profile({
    seed: (legacy) =>
      legacy.exec("INSERT INTO agent_session_attachment_claims VALUES('upload-1','unopened',1000)")
  })
  claimed.db.exec('DELETE FROM agent_session_attachment_claims')
  await claimed.launch().run()
  expect(companions(claimed.filename)).toEqual([])
  expect(
    claimed.db.prepare('SELECT upload_id,session_id FROM agent_session_attachment_claims').all()
  ).toEqual([{ upload_id: 'upload-1', session_id: 'unopened' }])

  // A rename made here, with the original as copied, is this store's newer edit.
  const renamedHere = await profile()
  renamedHere.db
    .prepare(
      `UPDATE agent_session_records SET record_json=json_set(record_json,
        '$.conversationName','Renamed here','$.conversationNameSource','user')`
    )
    .run()
  await renamedHere.launch().run()
  expect(companions(renamedHere.filename)).toEqual([])
})

it('accepts finished per-chat import markers earlier builds left behind', async () => {
  const { filename, launch, errors } = await profile({
    seed: (legacy) => legacy.exec("INSERT INTO journal_imports VALUES('unopened','epoch',1)")
  })
  await launch().run()
  expect(errors).toEqual([])
  expect(companions(filename)).toEqual([])
})

it('reopens the source to conversions when the lock helper fails', async () => {
  const { filename, launch, errors, readers } = await profile()
  const release = vi.spyOn(readers, 'releaseSourceReaders')
  await launch('1.0.1', true, async () => ({
    held: () => true,
    retire: async () => {
      throw new Error('helper stopped')
    },
    close: async () => {
      throw new Error('helper stopped')
    }
  })).run()
  expect(release).toHaveBeenCalledTimes(1)
  expect(errors).toHaveLength(1)
  expect(existsSync(filename)).toBe(true)
})

it('keeps the original version of what both sides changed, then retires, with no file times', async () => {
  // An older Orca renamed a chat after the copy, with no new turn, and then the profile was
  // restored with the journal written first: no file time can say which side is newer.
  const renamed = await profile()
  const before = statSync(renamed.filename)
  rename(renamed.filename, 'unopened', 'Renamed in the older Orca')
  utimesSync(renamed.filename, before.atime, before.mtime)
  await initializeJournalDomainDatabase(renamed.root)
  await renamed.launch().run()
  expect(renamed.errors).toEqual([])
  expect(companions(renamed.filename)).toEqual([])
  expect(original(renamed.db, 'unopened').record).toContain('Renamed in the older Orca')

  // Text an older Orca queued after the copy, on a converted chat this store doesn't hold.
  const queued = await profile()
  await queued.convert('unopened')
  queue(queued.filename, 'unopened', 'queued in the older Orca')
  await initializeJournalDomainDatabase(queued.root)
  await queued.launch().run()
  expect(companions(queued.filename)).toEqual([])
  expect(JSON.stringify(original(queued.db, 'unopened').queued)).toContain(
    'queued in the older Orca'
  )

  // Text an older Orca queued in a chat deleted here moves no revision; it is kept all the same.
  const deletedQueued = await profile()
  await deletedQueued.convert('unopened')
  await initializeJournalDomainDatabase(deletedQueued.root)
  deletedQueued.db.exec("DELETE FROM agent_session_records WHERE session_id='unopened'")
  deletedQueued.db.exec("DELETE FROM journal_chat_state WHERE session_id='unopened'")
  queue(deletedQueued.filename, 'unopened', 'queued after the chat was deleted here')
  rename(deletedQueued.filename, 'unopened', 'Renamed after the chat was deleted here')
  await initializeJournalDomainDatabase(deletedQueued.root)
  await deletedQueued.launch().run()
  expect(companions(deletedQueued.filename)).toEqual([])
  expect(JSON.stringify(original(deletedQueued.db, 'unopened').queued)).toContain(
    'queued after the chat was deleted here'
  )
  expect(original(deletedQueued.db, 'unopened').record).toContain(
    'Renamed after the chat was deleted here'
  )

  // An older Orca rewrites lease bookkeeping in every record each launch; until the original goes,
  // that keeps no further copy of a chat deleted here.
  const churn = await profile()
  churn.db.exec("DELETE FROM agent_session_records WHERE session_id='unopened'")
  churn.db.exec("DELETE FROM journal_chat_state WHERE session_id='unopened'")
  const tables = new Set(['agent_session_records', 'queued_messages', 'journal_outcome_epochs'])
  const kept = readLegacyProofSessions(churn.source(), churn.db, tables, null)[0]!.original!
  const legacyChurn = new Database(churn.filename)
  legacyChurn.exec(`UPDATE agent_session_records
    SET record_json=json_set(record_json,'$.lease.lastRenewedAt',2000)`)
  legacyChurn.close()
  await churn.readers.recycleSourceReaders()
  const after = readLegacyProofSessions(churn.source(), churn.db, tables, null)[0]!.original!
  expect(after.value).not.toBe(kept.value)
  expect(after.identity).toBe(kept.identity)

  // Text an older Orca queued in a converted chat it no longer records is kept the same way.
  const unrecordedQueued = await profile()
  await unrecordedQueued.convert('unopened')
  const legacy = new Database(unrecordedQueued.filename)
  legacy.exec("DELETE FROM agent_session_records WHERE session_id='unopened'")
  legacy.close()
  queue(unrecordedQueued.filename, 'unopened', 'queued in an unrecorded chat')
  await initializeJournalDomainDatabase(unrecordedQueued.root)
  await unrecordedQueued.launch().run()
  expect(companions(unrecordedQueued.filename)).toEqual([])
  expect(JSON.stringify(original(unrecordedQueued.db, 'unopened').queued)).toContain(
    'queued in an unrecorded chat'
  )

  // A later retirement of a restored original keeps its own version beside the first one.
  olderOrcaChat(queued.filename, 'unopened')
  queue(queued.filename, 'unopened', 'queued in a restored original')
  await initializeJournalDomainDatabase(queued.root)
  await queued.launch('1.0.2').run()
  expect(companions(queued.filename)).toEqual([])
  expect(JSON.stringify(originals(queued.db, 'unopened').map((kept) => kept.queued))).toMatch(
    /queued in the older Orca.*queued in a restored original|queued in a restored original.*queued in the older Orca/
  )

  // Where both sides already agree, nothing extra is kept.
  const same = await profile()
  await same.launch().run()
  expect(companions(same.filename)).toEqual([])
  expect(original(same.db, 'unopened')).toBeNull()
})

it('accepts an import marker for an epoch a /clear replaced', async () => {
  const { filename, launch, errors } = await profile({
    seed: (legacy) => legacy.exec("INSERT INTO journal_imports VALUES('unopened','replaced',9)")
  })
  await launch().run()
  expect(errors).toEqual([])
  expect(companions(filename)).toEqual([])
})

it('finishes removing the absorbed WAL a removal left behind its main file, and no other', async () => {
  const { filename, db, launch } = await profile()
  await launch().run()
  writeFileSync(`${filename}-wal`, 'absorbed frames')
  const wal = statSync(`${filename}-wal`, { bigint: true })
  const retiring = (ino: bigint) =>
    JSON.stringify({
      version: 2,
      phase: 'retiring',
      store: 'store',
      proof: JSON.stringify({
        wal: {
          kind: 'nonempty',
          size: String(wal.size),
          ino: String(ino),
          mtimeNs: String(wal.mtimeNs)
        }
      })
    })
  const save = (value: string) =>
    db
      .prepare(
        "UPDATE agent_session_store_meta SET value=? WHERE key='journal.legacy-retirement.v2'"
      )
      .run(value)
  save(retiring(wal.ino + 1n))
  await launch().run()
  expect(existsSync(`${filename}-wal`)).toBe(true)
  save(retiring(wal.ino))
  // Finishing the removal deletes too, so a build that keeps the file keeps these, and says so.
  const deferred: string[] = []
  setLegacyJournalRetirementHost({ report: async (event) => deferred.push(event.defer) > 0 })
  cleanup.push(() => setLegacyJournalRetirementHost(undefined))
  await launch('1.0.1', true, undefined, undefined, false).run()
  expect(existsSync(`${filename}-wal`)).toBe(true)
  expect(deferred).toEqual(['leftover_files'])
  await launch().run()
  expect(existsSync(`${filename}-wal`)).toBe(false)
})

it('checks unsupported storage once per launch, not on every retry', async () => {
  const { filename, launch, errors } = await profile()
  const check = vi.fn(async () => {
    throw new JournalLegacyIneligibleError('legacy storage or file identity is unsupported')
  })
  const retirement = launch('1.0.1', true, undefined, {
    check,
    present: () => {}
  })
  const now = vi.spyOn(performance, 'now')
  for (let hour = 0; hour < 48; hour++) {
    now.mockReturnValue(hour * 60 * 60_000)
    await retirement.run()
  }
  expect(check).toHaveBeenCalledTimes(1)
  expect(errors).toHaveLength(1)
  expect(existsSync(filename)).toBe(true)
})

it('backs off, with no durable commit, while the source readers stay busy', async () => {
  const { filename, db, launch, readers } = await profile()
  const recycle = vi.spyOn(readers, 'recycleSourceReaders').mockResolvedValue(null)
  const retirement = launch()
  const now = vi.spyOn(performance, 'now')
  for (let minute = 0; minute < 10; minute++) {
    now.mockReturnValue(minute * 60_000)
    await retirement.run()
  }
  // 1, 2 and 4 minute waits: four tries in ten minutes, never one per tick.
  expect(recycle.mock.calls.length).toBeLessThanOrEqual(4)
  const saved = db
    .prepare("SELECT value FROM agent_session_store_meta WHERE key='journal.legacy-retirement.v2'")
    .get()
  expect(saved && JSON.parse(String(saved.value)).phase).not.toBe('retiring')
  expect(existsSync(filename)).toBe(true)
})

it('weighs drafts and queued text from content, keeping only what only the original holds', async () => {
  // Text waiting in a chat not converted yet converts with it, so it doesn't block retirement.
  const unopened = await profile()
  queue(unopened.filename, 'unopened', 'queued before the copy')
  await initializeJournalDomainDatabase(unopened.root)
  await unopened.launch().run()
  expect(companions(unopened.filename)).toEqual([])

  // A draft (record, no history) an older Orca renamed after the copy is kept the same way.
  const draft = await profile({
    seed: (legacy) =>
      legacy
        .prepare('INSERT INTO agent_session_records VALUES(?,?)')
        .run('draft', JSON.stringify({ sessionId: 'draft', lease: { sessionId: 'draft' } }))
  })
  rename(draft.filename, 'draft', 'Draft renamed in the older Orca')
  await initializeJournalDomainDatabase(draft.root)
  await draft.launch().run()
  expect(companions(draft.filename)).toEqual([])
  expect(original(draft.db, 'draft').record).toContain('Draft renamed in the older Orca')
})

it('finds queue cards by key, never by reading every card a chat has', async () => {
  const { root, filename, db, launch, convert } = await profile()
  await convert('unopened')
  queue(filename, 'unopened', 'still waiting')
  await initializeJournalDomainDatabase(root)
  const statements = new Set<string>()
  const prepare = db.prepare.bind(db)
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    statements.add(sql)
    return prepare(sql)
  })
  await launch().run()
  vi.mocked(db.prepare).mockRestore()
  const cardReads = [...statements].filter((sql) => sql.includes('FROM journal_queue_cards'))
  expect(cardReads.length).toBeGreaterThan(0)
  for (const sql of cardReads) {
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 'x'))
      .map((row) => String(row.detail))
      .join('\n')
    // A seek on the key, on (session, epoch), or one covering-index entry; never a read of every
    // card the chat has, payloads included.
    const firstEntry = /LIMIT 1/.test(sql) && plan.includes('COVERING INDEX')
    expect(firstEntry || /PRIMARY KEY|session_id=\? AND epoch[>=]\?/.test(plan)).toBe(true)
  }
})

it('converts the copies the reconcile keeps, and keeps the original while a chat is unsettled', async () => {
  // An older Orca continued a converted chat: the reconcile keeps its version as a copy whose
  // history still lives only in the original, so the copy converts before the original goes.
  const continued = await profile()
  await continued.convert('unopened')
  continueInOlderOrca(continued.filename, 'unopened')
  await initializeJournalDomainDatabase(continued.root)
  const copy = String(
    continued.db
      .prepare(
        "SELECT key FROM agent_session_store_meta WHERE key LIKE 'journal.legacy-copy-source:%'"
      )
      .get()!.key
  ).slice('journal.legacy-copy-source:'.length)
  expect(journalDomainImportState(continued.db, copy).state).toBe('converting')
  await continued.launch().run()
  expect(continued.errors).toEqual([])
  expect(companions(continued.filename)).toEqual([])
  expect(journalDomainImportState(continued.db, copy).state).toBe('ready')

  // A chat the reconcile recorded as failed took its revision without its content.
  const failed = await profile()
  await failed.convert('unopened')
  failed.db.exec(`INSERT INTO agent_session_store_meta VALUES('journal.legacy-failed:unopened',
    '{"revision":null,"error":"original chat unreadable"}')`)
  await failed.launch().run()
  expect(companions(failed.filename)).toContain(failed.filename)
  expect(String(failed.errors.at(-1))).toContain('could not be kept')

  // A compare still due hasn't said whether this store holds the chat; once it settles, the same
  // launch retires the original.
  const comparing = await profile()
  await comparing.convert('unopened')
  comparing.db.exec(`INSERT INTO agent_session_store_meta
    VALUES('journal.legacy-compare:unopened','["epoch",9,null,null]')`)
  vi.useFakeTimers({ toFake: ['performance'] })
  const retirement = comparing.launch()
  await retirement.run()
  expect(companions(comparing.filename)).toContain(comparing.filename)
  expect(String(comparing.errors.at(-1))).toContain('still being compared')
  comparing.db.exec(
    "DELETE FROM agent_session_store_meta WHERE key='journal.legacy-compare:unopened'"
  )
  vi.advanceTimersByTime(60_000)
  await retirement.run()
  vi.useRealTimers()
  expect(companions(comparing.filename)).toEqual([])

  // A copy whose conversion failed is left for an open to retry; the proof only refuses.
  const failedCopy = await profile()
  await failedCopy.convert('unopened')
  continueInOlderOrca(failedCopy.filename, 'unopened')
  await initializeJournalDomainDatabase(failedCopy.root)
  const failedCopyId = String(
    failedCopy.db
      .prepare(
        "SELECT key FROM agent_session_store_meta WHERE key LIKE 'journal.legacy-copy-source:%'"
      )
      .get()!.key
  ).slice('journal.legacy-copy-source:'.length)
  failedCopy.db
    .prepare('INSERT INTO agent_session_store_meta VALUES(?,?)')
    .run(`journal.legacy-failed:${failedCopyId}`, '{"revision":null,"error":"reply too large"}')
  failedCopy.ensured.length = 0
  await failedCopy.launch().run()
  expect(companions(failedCopy.filename)).toContain(failedCopy.filename)
  expect(failedCopy.ensured).not.toContain(failedCopyId)
  expect(String(failedCopy.errors.at(-1))).toContain('could not be converted')

  // A copy whose chat an older Orca then deleted from the original has nothing left to take.
  const goneCopy = await profile()
  await goneCopy.convert('unopened')
  continueInOlderOrca(goneCopy.filename, 'unopened')
  await initializeJournalDomainDatabase(goneCopy.root)
  const gone = new Database(goneCopy.filename)
  gone.exec(`DELETE FROM journal_rows WHERE session_id='unopened';
    DELETE FROM journal_sessions WHERE session_id='unopened';
    DELETE FROM agent_session_records WHERE session_id='unopened'`)
  gone.close()
  await initializeJournalDomainDatabase(goneCopy.root)
  await goneCopy.launch().run()
  expect(goneCopy.errors).toEqual([])
  expect(companions(goneCopy.filename)).toEqual([])

  // A chat too large for one reply fails the same way at every retry: refused once, not reconverted.
  const oversized = await profile({
    failConversion: {
      sessionId: 'unopened',
      error: new Error('journal read reply (rows) exceeds 67108864 bytes')
    }
  })
  vi.useFakeTimers({ toFake: ['performance'] })
  const oversizedRetirement = oversized.launch()
  for (let attempt = 0; attempt < 5; attempt++) {
    await oversizedRetirement.run()
    vi.advanceTimersByTime(60 * 60_000)
  }
  vi.useRealTimers()
  expect(companions(oversized.filename)).toContain(oversized.filename)
  expect(oversized.ensured.filter((id) => id === 'unopened')).toHaveLength(1)
  expect(String(oversized.errors.at(-1))).toContain('too large to convert')

  // A copy whose conversion fails once is converted on the next attempt, with none skipped.
  const twoCopies = await profile()
  olderOrcaChat(twoCopies.filename, 'second')
  await initializeJournalDomainDatabase(twoCopies.root)
  await twoCopies.convert('unopened')
  await twoCopies.convert('second')
  continueInOlderOrca(twoCopies.filename, 'unopened')
  continueInOlderOrca(twoCopies.filename, 'second')
  await initializeJournalDomainDatabase(twoCopies.root)
  const copies = twoCopies.db
    .prepare(
      `SELECT substr(key,28) AS id FROM agent_session_store_meta
      WHERE key LIKE 'journal.legacy-copy-source:%' ORDER BY key`
    )
    .all()
    .map((row) => String(row.id))
  expect(copies).toHaveLength(2)
  twoCopies.failOnce.set(copies[1]!, new Error('journal SQL reader exited'))
  vi.useFakeTimers({ toFake: ['performance'] })
  const twoCopiesRetirement = twoCopies.launch()
  await twoCopiesRetirement.run()
  expect(companions(twoCopies.filename)).toContain(twoCopies.filename)
  vi.advanceTimersByTime(60_000)
  await twoCopiesRetirement.run()
  vi.useRealTimers()
  expect(companions(twoCopies.filename)).toEqual([])
  for (const copy of copies) {
    expect(journalDomainImportState(twoCopies.db, copy).state).toBe('ready')
  }

  // A compare due on a chat the original holds refuses before any chat converts; one left for a
  // chat the original no longer holds doesn't keep it.
  const dueFirst = await profile()
  // More chats than one proof page holds, so the due chat is on a later page.
  for (let chat = 0; chat < 32; chat++) {
    olderOrcaChat(dueFirst.filename, `a${String(chat).padStart(2, '0')}`)
  }
  olderOrcaChat(dueFirst.filename, 'zz-later')
  await initializeJournalDomainDatabase(dueFirst.root)
  dueFirst.db.exec(`INSERT INTO agent_session_store_meta
    VALUES('journal.legacy-compare:zz-later','["epoch",9,null,null]')`)
  dueFirst.ensured.length = 0
  await dueFirst.launch().run()
  expect(dueFirst.ensured).toEqual([])
  expect(companions(dueFirst.filename)).toContain(dueFirst.filename)
  const stale = await profile()
  stale.db.exec(`INSERT INTO agent_session_store_meta
    VALUES('journal.legacy-compare:deleted-in-older-orca','["epoch",9,null,null]')`)
  await stale.launch().run()
  expect(stale.errors).toEqual([])
  expect(companions(stale.filename)).toEqual([])
})

it('resumes the proof where an earlier launch stopped, not from the first chat', async () => {
  // More drafts than 16 proof pages hold, so the first launch saves progress before it stops.
  const many = await profile({
    seed: (legacy) => {
      const insert = legacy.prepare('INSERT INTO agent_session_records VALUES(?,?)')
      for (let draft = 0; draft < 600; draft++) {
        const id = `draft-${String(draft).padStart(3, '0')}`
        insert.run(id, JSON.stringify({ sessionId: id }))
      }
    }
  })
  const read = many.readers.legacyProof
  const cursors: Parameters<typeof read>[0][] = []
  let stopAfter = 17
  many.readers.legacyProof = async (cursor) => {
    cursors.push(cursor)
    if (cursors.length > stopAfter) {
      throw new Error('Orca quit')
    }
    return read(cursor)
  }
  await many.launch().run()
  expect(companions(many.filename)).toContain(many.filename)
  // The next launch starts at the saved page and checks compares due again; then it finishes.
  cursors.length = 0
  stopAfter = Number.POSITIVE_INFINITY
  await many.launch().run()
  expect(cursors[0]).toMatchObject({ table: 0, check: true })
  expect(cursors[0]!.after).not.toBeNull()
  expect(many.errors.at(-1)).toMatchObject({ message: 'Orca quit' })
  expect(companions(many.filename)).toEqual([])
})

it('resumes after a deletion that did not go through, and checks what an older Orca pass added since', async () => {
  // The proof finished and saved 'retiring', but the delete failed: the next launch starts at the
  // copies, not the first chat.
  const retried = await profile()
  let failDelete = true
  const flaky = async (filename: string) => {
    const lease = await fakeLease(filename)
    return { ...lease, retire: async () => (failDelete ? false : lease.retire()) }
  }
  await retried.launch('1.0.1', true, flaky).run()
  expect(companions(retried.filename)).toContain(retried.filename)
  const read = retried.readers.legacyProof
  const cursors: Parameters<typeof read>[0][] = []
  retried.readers.legacyProof = async (cursor) => {
    cursors.push(cursor)
    return read(cursor)
  }
  failDelete = false
  await retried.launch('1.0.1', true, flaky).run()
  expect(cursors[0]).toMatchObject({ table: 7, after: null, check: true })
  expect(companions(retried.filename)).toEqual([])

  // A failure the reconcile records between launches refuses a resumed proof too.
  const failedSince = await profile()
  await failedSince
    .launch('1.0.1', true, async (filename) => {
      const lease = await fakeLease(filename)
      return { ...lease, retire: async () => false }
    })
    .run()
  failedSince.db.exec(`INSERT INTO agent_session_store_meta VALUES('journal.legacy-failed:unopened',
    '{"revision":null,"error":"original chat unreadable"}')`)
  await failedSince.launch().run()
  expect(companions(failedSince.filename)).toContain(failedSince.filename)
  expect(String(failedSince.errors.at(-1))).toContain('could not be kept')
})

it('keeps a chat deleted here from a journal written before some queue columns existed', async () => {
  const older = await profile({
    seed: (legacy) =>
      legacy.exec(`ALTER TABLE queued_messages DROP COLUMN options_json;
        ALTER TABLE queued_messages DROP COLUMN carried_from`)
  })
  queue(older.filename, 'unopened', 'queued in an older journal')
  await initializeJournalDomainDatabase(older.root)
  const columns = older
    .source()
    .prepare('PRAGMA table_info(queued_messages)')
    .all()
    .map((column) => column.name)
  expect(columns).not.toContain('options_json')
  older.db.exec("DELETE FROM agent_session_records WHERE session_id='unopened'")
  older.db.exec("DELETE FROM journal_chat_state WHERE session_id='unopened'")
  await older.launch().run()
  expect(older.errors).toEqual([])
  expect(companions(older.filename)).toEqual([])
  expect(JSON.stringify(original(older.db, 'unopened').queued)).toContain(
    'queued in an older journal'
  )
})

const savedRetirement = (db: Database.Database) =>
  JSON.parse(
    String(
      db
        .prepare(
          "SELECT value FROM agent_session_store_meta WHERE key='journal.legacy-retirement.v2'"
        )
        .get()?.value ?? 'null'
    )
  )

it('retires a journal v1.4.219 wrote, with or without its Stop pauses, upgraded or not', async () => {
  const shapes = [
    (filename: string) => v1_4_219Journal(filename, 'unopened', false),
    // As Stop left it: a pause and the cards still waiting.
    (filename: string) => {
      v1_4_219Journal(filename, 'unopened', true)
      queue(filename, 'unopened', 'queued before Stop in v1.4.219')
    },
    // A later build's writable open upgrades the rest of the file, never the pause table.
    (filename: string) => {
      v1_4_219Journal(filename, 'unopened', true)
      olderOrcaChat(filename, 'continued-later')
    }
  ]
  for (const original of shapes) {
    const older = await profile({ original })
    await older.launch().run()
    expect(older.errors).toEqual([])
    expect(companions(older.filename)).toEqual([])
    expect(journalDomainImportState(older.db, 'unopened').state).toBe('ready')
  }
})

it('keeps a journal whose pause table is not the one v1.4.219 created', async () => {
  const reshaped = [
    'ALTER TABLE queued_message_pauses ADD COLUMN body_json TEXT',
    'ALTER TABLE queued_message_pauses DROP COLUMN recorded_at',
    // The retired column belongs to the queue only.
    'ALTER TABLE journal_rows ADD COLUMN source_json TEXT'
  ]
  for (const change of reshaped) {
    const older = await profile({
      original: (filename) => {
        v1_4_219Journal(filename, 'unopened', true)
        const db = new Database(filename)
        db.exec(change)
        db.close()
      }
    })
    await older.launch().run()
    expect(companions(older.filename)).toContain(older.filename)
    expect(savedRetirement(older.db)).toMatchObject({
      phase: 'refused',
      reason: 'source-inventory'
    })
  }
})

it('retires a journal with the queue sender column, counting it against what a kept original holds', async () => {
  const withSender = (sender: string) => async () => {
    const older = await profile({
      seed: (legacy) => legacy.exec('ALTER TABLE queued_messages ADD COLUMN source_json TEXT')
    })
    queue(older.filename, 'unopened', 'queued by an hourly build')
    const legacy = new Database(older.filename)
    legacy.prepare('UPDATE queued_messages SET source_json=?').run(sender)
    legacy.close()
    await initializeJournalDomainDatabase(older.root)
    return older
  }
  const small = await withSender('{"v":1,"kind":"agent"}')()
  await small.launch().run()
  expect(small.errors).toEqual([])
  expect(companions(small.filename)).toEqual([])

  // Deleted here, so its waiting card would be kept as the original's version, sender and all.
  const large = await withSender('x'.repeat(3 * 1024 * 1024))()
  large.db.exec("DELETE FROM agent_session_records WHERE session_id='unopened'")
  large.db.exec("DELETE FROM journal_chat_state WHERE session_id='unopened'")
  await large.launch().run()
  expect(companions(large.filename)).toContain(large.filename)
  expect(savedRetirement(large.db)).toMatchObject({ phase: 'refused', reason: 'source-oversize' })
})

it('proves once more an inventory refusal saved before historical shapes were accepted', async () => {
  const refusedAs = async (refusal: Record<string, unknown>) => {
    // The journal those builds refused: v1.4.219's, with a pause and a card waiting.
    const refused = await profile({
      original: (filename) => {
        v1_4_219Journal(filename, 'unopened', true)
        queue(filename, 'unopened', 'queued before Stop in v1.4.219')
      }
    })
    const proof = JSON.stringify(await readJournalLegacySourceReceipt(refused.filename))
    const store = await legacyDestinationMain(journalDomainDatabasePath(refused.root))
    refused.db
      .prepare('INSERT OR REPLACE INTO agent_session_store_meta(key,value) VALUES(?,?)')
      .run(
        'journal.legacy-retirement.v2',
        JSON.stringify({ version: 2, phase: 'refused', policy: 3, proof, store, ...refusal })
      )
    return refused
  }
  // As builds before this one saved them.
  for (const reason of ['source-inventory', 'source-recovery']) {
    const earlier = await refusedAs({ reason })
    await earlier.launch().run()
    expect(earlier.errors).toEqual([])
    expect(companions(earlier.filename)).toEqual([])
  }
  // Saved under this inventory check, or for content: honoured without a proof.
  for (const refusal of [
    { reason: 'source-inventory', inventory: 2 },
    // A later build's own inventory check refused it.
    { reason: 'source-inventory', inventory: 3 },
    { reason: 'source-oversize' }
  ]) {
    const kept = await refusedAs(refusal)
    const legacyProof = vi.spyOn(kept.readers, 'legacyProof')
    await kept.launch().run()
    expect(legacyProof).not.toHaveBeenCalled()
    expect(companions(kept.filename)).toContain(kept.filename)
  }
})

it('saves a refusal older builds honour too', async () => {
  const unknown = await profile({
    seed: (legacy) => legacy.exec('CREATE TABLE written_by_a_newer_build (value TEXT)')
  })
  await unknown.launch().run()
  expect(savedRetirement(unknown.db)).toMatchObject({
    phase: 'refused',
    policy: 3,
    reason: 'source-inventory',
    inventory: 2
  })
  const legacyProof = vi.spyOn(unknown.readers, 'legacyProof')
  await unknown.launch().run()
  expect(legacyProof).not.toHaveBeenCalled()
  expect(companions(unknown.filename)).toContain(unknown.filename)
})
