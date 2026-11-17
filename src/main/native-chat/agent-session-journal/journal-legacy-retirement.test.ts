import { existsSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { journalDomainImportState } from './journal-domain-import-rows'
import { initializeJournalDomainDatabase } from './database/journal-domain-database'
import { olderOrcaChat, profile } from './journal-legacy-retirement.test-fixture'
import { JournalLegacyIneligibleError } from './journal-legacy-retention-error'

function rename(filename: string, sessionId: string, name: string) {
  const db = new Database(filename)
  db.prepare(`UPDATE agent_session_records SET record_json=json_set(record_json,
    '$.conversationName',?,'$.conversationNameSource','user') WHERE session_id=?`).run(
    name,
    sessionId
  )
  db.close()
}

function queue(filename: string, sessionId: string, text: string) {
  const db = new Database(filename)
  db.prepare(`INSERT INTO queued_messages
    (session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state)
    VALUES(?,?,?,?,?,?,?,?)`).run(
    sessionId,
    'queued-after-copy',
    1,
    JSON.stringify({ kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }),
    'fingerprint',
    1000,
    'older-host',
    'waiting'
  )
  db.close()
}

const refusal = (db: Database.Database) =>
  JSON.parse(
    String(
      db
        .prepare(
          "SELECT value FROM agent_session_store_meta WHERE key='journal.legacy-retirement.v2'"
        )
        .get()?.value ?? 'null'
    )
  )

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

it('deletes the original on a later version once every chat converted, and later opens leave it alone', async () => {
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
  await launch().run()
  expect(errors).toEqual([])
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

  // An older Orca renamed a chat after the copy, with no new turn: the reconcile doesn't take
  // renames, so the original holds a person's name the store lacks.
  const renamed = await profile()
  rename(renamed.filename, 'unopened', 'Renamed in the older Orca')
  await initializeJournalDomainDatabase(renamed.root)
  await renamed.launch().run()
  expect(companions(renamed.filename)).toContain(renamed.filename)
  expect(refusal(renamed.db)).toMatchObject({ reason: 'source-record-diverged' })

  // Text an older Orca queued after the copy that this store doesn't hold.
  const queued = await profile()
  queue(queued.filename, 'unopened', 'queued in the older Orca')
  await initializeJournalDomainDatabase(queued.root)
  await queued.launch().run()
  expect(companions(queued.filename)).toContain(queued.filename)
  expect(refusal(queued.db)).toMatchObject({ reason: 'source-queue-unheld' })

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
})

it('finishes a removal stopped after the main file went', async () => {
  const { filename, launch, errors } = await profile()
  await launch().run()
  writeFileSync(`${filename}-wal`, '')
  writeFileSync(`${filename}-shm`, 'index')
  await launch().run()
  expect(errors).toEqual([])
  expect(companions(filename)).toEqual([])
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

it('retires a store copied before the copy record existed, from its content', async () => {
  // Every store v1.4.260/261 copied: a person's edits that differ are weighed by file times only.
  const unchanged = await profile()
  unchanged.db.exec(
    "DELETE FROM agent_session_store_meta WHERE key='journal.legacy-copied-source.v2'"
  )
  await unchanged.launch().run()
  expect(unchanged.errors).toEqual([])
  expect(companions(unchanged.filename)).toEqual([])

  // A chat deleted here is not converted back from the original, and doesn't block retirement.
  const deleted = await profile()
  deleted.db.exec(
    "DELETE FROM agent_session_store_meta WHERE key='journal.legacy-copied-source.v2'"
  )
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

it('keeps an original an older Orca renamed a chat in, even with its mtime put back', async () => {
  // The rename moves no history, and restoring mtime leaves only ctime moved; that still counts.
  const { root, filename, launch, db } = await profile()
  const before = statSync(filename)
  rename(filename, 'unopened', 'Renamed in the older Orca')
  utimesSync(filename, before.atime, before.mtime)
  await initializeJournalDomainDatabase(root)
  await launch().run()
  expect(companions(filename)).toContain(filename)
  expect(refusal(db)).toMatchObject({ reason: 'source-record-diverged' })
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
  await launch().run()
  expect(existsSync(`${filename}-wal`)).toBe(false)
})

it('checks unsupported storage once per launch, not on every retry', async () => {
  const { filename, launch, errors } = await profile()
  const check = vi.fn(async () => {
    throw new JournalLegacyIneligibleError('legacy storage or file identity is unsupported')
  })
  const retirement = launch('1.0.1', true, undefined, { check, present: () => {} })
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
  expect(
    db
      .prepare("SELECT 1 FROM agent_session_store_meta WHERE key='journal.legacy-retirement.v2'")
      .get()
  ).toBeUndefined()
  expect(existsSync(filename)).toBe(true)
})
