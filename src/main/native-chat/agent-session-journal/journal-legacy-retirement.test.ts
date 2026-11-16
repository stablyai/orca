import { existsSync, utimesSync, writeFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { journalDomainImportState } from './journal-domain-import-rows'
import { initializeJournalDomainDatabase } from './database/journal-domain-database'
import { olderOrcaChat, profile } from './journal-legacy-retirement.test-fixture'

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

  // An older Orca wrote the original after the copy: even once reconciled, records and queues it
  // changed may not show in any chat revision.
  const written = await profile()
  olderOrcaChat(written.filename, 'downgrade-chat')
  await initializeJournalDomainDatabase(written.root)
  await written.launch().run()
  expect(companions(written.filename)).toContain(written.filename)
  expect(written.errors).toEqual([])

  // Content the proof can't account for is refused, and the refusal is not re-proven.
  const orphan = await profile({
    seed: (legacy) =>
      legacy.exec("INSERT INTO journal_rows VALUES('orphan','old',1,1,'unaccounted user text')")
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

it('after a downgrade to an older Orca, the re-upgrade shows its new chat and keeps its journal', async () => {
  const { root, filename, db, launch } = await profile()
  await launch().run()
  expect(existsSync(filename)).toBe(false)
  const before = tabsAndRecords(db).records.length

  // The older Orca finds no journal, starts a new one and saves one chat in it.
  olderOrcaChat(filename, 'made-after-downgrade')
  await initializeJournalDomainDatabase(root)

  expect(tabsAndRecords(db).records.length).toBe(before + 1)
  expect(
    db.prepare('SELECT 1 FROM agent_session_records WHERE session_id=?').get('made-after-downgrade')
  ).toBeDefined()
  await launch('1.0.2').run()
  expect(existsSync(filename)).toBe(true)
})

const meta = (db: Database.Database, key: string) =>
  db.prepare('SELECT value FROM agent_session_store_meta WHERE key=?').get(key)?.value

it('judges a store copied before the copy record once, from whether the original was written since', async () => {
  const unwritten = await profile({
    // Finished per-chat import markers an earlier build left behind hold nothing the rows don't.
    seed: (legacy) => legacy.exec("INSERT INTO journal_imports VALUES('unopened','epoch',1)")
  })
  unwritten.db.exec(
    "DELETE FROM agent_session_store_meta WHERE key='journal.legacy-copied-source.v1'"
  )
  await unwritten.launch().run()
  expect(unwritten.errors).toEqual([])
  expect(companions(unwritten.filename)).toEqual([])

  const written = await profile()
  written.db.exec(
    "DELETE FROM agent_session_store_meta WHERE key='journal.legacy-copied-source.v1'"
  )
  const later = new Date(Date.now() + 60_000)
  utimesSync(written.filename, later, later)
  await initializeJournalDomainDatabase(written.root)
  await written.launch().run()
  expect(companions(written.filename)).toContain(written.filename)
  expect(meta(written.db, 'journal.legacy-copied-source.v1')).toBe('written-after-copy')
  // The judgment stands even once the files look unchanged again.
  await written.launch().run()
  expect(companions(written.filename)).toContain(written.filename)
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
