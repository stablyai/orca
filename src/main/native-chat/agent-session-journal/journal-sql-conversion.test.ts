import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import type { JournalHostDatabase } from './journal-host-database'
import { publishJournalOutcomeEpoch } from './journal-outcome-write'
import { restoreJournal } from './journal-open'
import { memoryJournalMap } from './journal-memory-collections'
import { JournalSqlReducer } from './journal-sql-reducer'
import { JournalSqlScope } from './journal-sql-scope'
import { currentJournalSqlEpoch } from './journal-sql-meta'
import {
  convertJournalSqlProjection,
  finishJournalSqlConversion,
  prepareJournalSqlConversion
} from './journal-sql-conversion'
import { sweepJournalSqlProjectionPage } from './journal-sql-projection-sweep'
import { journalSqlProjectionSchema } from './journal-sql-projection-schema'
import { journalSqlControlSnapshot } from './journal-sql-control-export.test-fixture'
import { journalSqlLifecycleRows } from './journal-sql-reducer-rows.test-fixture'
import { journalSqlRetryRows } from './journal-sql-retry-rows.test-fixture'

let root: string
let database: JournalHostDatabase
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-conversion-'))
  database = openTestJournalHostDatabase(root)
})
afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

it.each([
  { name: 'lifecycle and rollback', rows: journalSqlLifecycleRows() },
  { name: 'native queue and retry families', rows: journalSqlRetryRows(false) },
  { name: 'legacy queue and retry families', rows: journalSqlRetryRows(true) }
])('converts a saved chat once into the state its open restores: $name', ({ rows }) => {
  database.transaction((db) => {
    publishTestJournalEpoch(db, 'session', 'epoch')
    publishJournalOutcomeEpoch(db, 'session', 'epoch', rows).adopt()
  })
  const { db } = database
  const epoch = database.transaction((tx) => convertJournalSqlProjection(tx, 'session'))

  expect(epoch).toBe('epoch')
  expect(currentJournalSqlEpoch(db, 'session')).toBe('epoch')
  const restored = restoreJournal(db, 'session')!.state
  const converted = new JournalSqlReducer(new JournalSqlScope(db, 'session', 'epoch'), 'epoch')
    .state
  expect(journalSqlControlSnapshot(converted)).toEqual(journalSqlControlSnapshot(restored))
  for (const [key, item] of memoryJournalMap(restored.items)) {
    expect(converted.items.get(key)).toEqual(item)
  }
  const pointed = db
    .prepare(`SELECT COUNT(*) AS count FROM journal_proj_item_versions
    WHERE epoch=? AND outcome_seq IS NOT NULL AND inline_json IS NULL`)
    .get('epoch')?.count
  expect(pointed).toBeGreaterThan(0)
})

it('leaves a chat with no saved history for its first open to found', () => {
  database.transaction((db) => publishTestJournalEpoch(db, 'session', 'epoch'))
  expect(database.transaction((tx) => convertJournalSqlProjection(tx, 'session'))).toBeNull()
  expect(currentJournalSqlEpoch(database.db, 'session')).toBeNull()
})

it('publishes a conversion only while the log still has the coverage it was read at', () => {
  database.transaction((db) => {
    publishTestJournalEpoch(db, 'session', 'epoch')
    publishJournalOutcomeEpoch(db, 'session', 'epoch', journalSqlLifecycleRows()).adopt()
  })
  database.transaction((db) => {
    db.exec(journalSqlProjectionSchema())
    const conversion = prepareJournalSqlConversion(db, 'session')!
    publishTestJournalEpoch(db, 'session', 'replaced')
    expect(finishJournalSqlConversion(db, conversion)).toBe(false)
  })
  expect(currentJournalSqlEpoch(database.db, 'session')).toBeNull()
})

it('sweeps a retired epoch in bounded pages and keeps every current one', () => {
  for (const session of ['retired', 'current']) {
    database.transaction((db) => {
      publishTestJournalEpoch(db, session, 'epoch')
      publishJournalOutcomeEpoch(db, session, 'epoch', journalSqlLifecycleRows()).adopt()
    })
    database.transaction((db) => convertJournalSqlProjection(db, session))
  }
  const { db } = database
  const rows = (session: string) =>
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'
      AND name LIKE 'journal_proj_%' AND name <> 'journal_proj_meta'`)
      .all()
      .reduce(
        (count, { name }) =>
          count +
          Number(
            db
              .prepare(`SELECT COUNT(*) AS n FROM "${String(name)}" WHERE session_id=?`)
              .get(session)?.n
          ),
        0
      )
  const kept = rows('current')
  db.prepare(`UPDATE journal_proj_meta SET epoch='later' WHERE session_id='retired'`).run()
  let pages = 0
  while (database.transaction((tx) => sweepJournalSqlProjectionPage(tx, 8))) {
    pages++
  }
  expect(pages).toBeGreaterThan(1)
  expect(rows('retired')).toBe(0)
  expect(rows('current')).toBe(kept)
})
