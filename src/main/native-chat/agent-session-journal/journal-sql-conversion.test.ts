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
import { currentJournalSqlGeneration } from './journal-sql-meta'
import { convertJournalSqlProjection } from './journal-sql-conversion'
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
  const generation = database.transaction((tx) => convertJournalSqlProjection(tx, 'session'))

  expect(generation).not.toBeNull()
  expect(currentJournalSqlGeneration(db, 'session')).toBe(generation)
  const restored = restoreJournal(db, 'session')!.state
  const converted = new JournalSqlReducer(new JournalSqlScope(db, 'session', generation!), 'epoch')
    .state
  expect(journalSqlControlSnapshot(converted)).toEqual(journalSqlControlSnapshot(restored))
  for (const [key, item] of memoryJournalMap(restored.items)) {
    expect(converted.items.get(key)).toEqual(item)
  }
  const pointed = db
    .prepare(`SELECT COUNT(*) AS count FROM journal_proj_item_versions
    WHERE generation=? AND outcome_seq IS NOT NULL AND inline_json IS NULL`)
    .get(generation)?.count
  expect(pointed).toBeGreaterThan(0)
})

it('leaves a chat with no saved history for its first open to found', () => {
  database.transaction((db) => publishTestJournalEpoch(db, 'session', 'epoch'))
  expect(database.transaction((tx) => convertJournalSqlProjection(tx, 'session'))).toBeNull()
  expect(currentJournalSqlGeneration(database.db, 'session')).toBeNull()
})
