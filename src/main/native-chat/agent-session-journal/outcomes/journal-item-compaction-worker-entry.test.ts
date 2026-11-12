import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalHostDatabase } from '../database/journal-host-database'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import { restoreJournal } from '../replay/journal-open'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from '../store-lifecycle/journal-host-database-test-support'
import { compactJournalItemRevisionPage } from './journal-item-compaction-worker-entry'
import { journalCompactionIsIdle } from './journal-compaction-activity'
import { ensureJournalOutcomeTables } from './journal-outcome-format'
import { publishJournalOutcomeEpoch } from './journal-outcome-write'

const sessionId = 'compacted'
const epoch = 'epoch-1'
let root: string
let database: JournalHostDatabase

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-item-compaction-'))
  database = openTestJournalHostDatabase(root)
})
afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

const row = { v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION, epoch, ts: 1, fence: 1 }
const revision = (seq: number, text: string): JournalRow => ({
  ...row,
  seq,
  kind: 'item',
  itemId: 'reply',
  revision: seq,
  body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
})

const itemRecordSeqs = (field = 'items') =>
  database.db
    .prepare('SELECT seq FROM journal_outcomes WHERE field = ? ORDER BY generation, entry_key, seq')
    .all(field)
    .map(({ seq }) => seq)

it('stores only the first and newest record of a streamed item, and reopens to the newest', () => {
  database.transaction((db) => {
    publishTestJournalEpoch(db, sessionId, epoch)
    publishJournalOutcomeEpoch(db, sessionId, epoch, [
      {
        ...row,
        seq: 1,
        kind: 'epoch',
        reason: 'session_created',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      revision(2, 'H'),
      revision(3, 'He'),
      revision(4, 'Hel'),
      revision(5, 'Hello')
    ]).adopt()
  })

  expect(itemRecordSeqs()).toEqual([2, 5])
  const reopened = restoreJournal(database.db, sessionId)?.state.items.get('reply')
  expect(reopened?.body).toEqual({
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Hello' }]
  })
})

function seedOldHistory(): void {
  database.transaction((db) => {
    publishTestJournalEpoch(db, sessionId, epoch)
    publishJournalOutcomeEpoch(db, sessionId, epoch, [
      {
        ...row,
        seq: 1,
        kind: 'epoch',
        reason: 'session_created',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      revision(2, 'H')
    ]).adopt()
    const first = db
      .prepare("SELECT generation, ordinal, value_json FROM journal_outcomes WHERE field = 'items'")
      .get()!
    const insert = db.prepare(
      `INSERT INTO journal_outcomes VALUES (?, ?, 'items', '"reply"', 3, ?, ?, 0)`
    )
    for (const seq of [3, 4, 5, 6]) {
      insert.run(first.generation, seq, first.ordinal, first.value_json)
    }
    db.exec('UPDATE journal_outcome_epochs SET through_seq = 6')
  })
}

function compactOneDeletion(): void {
  let page
  do {
    page = compactJournalItemRevisionPage(database.db, { keys: 1, rows: 2 })
  } while (!page.done && page.deleted === 0)
}

function finishCompaction(): void {
  let done = false
  while (!done) {
    done = compactJournalItemRevisionPage(database.db, { keys: 1, rows: 2 }).done
  }
}

it('resumes a committed page after reopening and preserves the first and newest item', async () => {
  seedOldHistory()
  const before = restoreJournal(database.db, sessionId)
  compactOneDeletion()
  expect(itemRecordSeqs()).toEqual([2, 5, 6])
  await closeTestJournalHostDatabases()
  database = openTestJournalHostDatabase(root)
  finishCompaction()
  expect(itemRecordSeqs()).toEqual([2, 6])
  expect(restoreJournal(database.db, sessionId)).toEqual(before)
})

it.each(['format', 'marker', 'tail', 'record'] as const)(
  'preserves history with a newer %s contract across reopen',
  async (newer) => {
    seedOldHistory()
    if (newer === 'format') {
      database.db.exec('UPDATE journal_outcome_epochs SET format = 4')
    }
    if (newer === 'marker') {
      database.db.exec(`UPDATE journal_rows SET row_json = json_set(row_json, '$.v', 7)`)
    }
    if (newer === 'tail') {
      database.db.exec(`INSERT INTO journal_rows
      SELECT session_id, epoch, seq + 1, ts, row_json FROM journal_rows`)
    }
    if (newer === 'record') {
      database.db.exec(`UPDATE journal_outcomes SET format = 4 WHERE field = 'items' AND seq = 4`)
    }
    finishCompaction()
    expect(itemRecordSeqs()).toEqual([2, 3, 4, 5, 6])
    await closeTestJournalHostDatabases()
    database = openTestJournalHostDatabase(root)
    finishCompaction()
    expect(itemRecordSeqs()).toEqual([2, 3, 4, 5, 6])
  }
)

it('rolls back deletion when progress cannot commit, then recovers on reopen', async () => {
  seedOldHistory()
  compactOneDeletion()
  database.db.exec(`CREATE TRIGGER fail_progress BEFORE INSERT ON journal_maintenance
    BEGIN SELECT RAISE(ABORT, 'injected progress failure'); END`)
  expect(() => finishCompaction()).toThrow()
  expect(itemRecordSeqs()).toEqual([2, 5, 6])
  database.db.exec('DROP TRIGGER fail_progress')
  await closeTestJournalHostDatabases()
  database = openTestJournalHostDatabase(root)
  finishCompaction()
  expect(itemRecordSeqs()).toEqual([2, 6])
})

it('removes the persistent trigger before a newer writer can insert unknown records', () => {
  seedOldHistory()
  database.db.exec(`CREATE TRIGGER journal_outcome_item_supersede AFTER INSERT ON journal_outcomes
    BEGIN DELETE FROM journal_outcomes WHERE field = 'items' AND seq = 3; END`)
  ensureJournalOutcomeTables(database.db)
  database.db.exec(`INSERT INTO journal_outcomes
    SELECT generation, 7, field, entry_key, 4, ordinal, value_json, deleted
    FROM journal_outcomes WHERE field = 'items' AND seq = 6`)
  expect(itemRecordSeqs()).toEqual([2, 3, 4, 5, 6, 7])
})

it('defers history deletion while the serving database is active, then resumes', () => {
  seedOldHistory()
  const idle = () => journalCompactionIsIdle(database.compactionActivity)
  compactJournalItemRevisionPage(database.db, { keys: 1, rows: 2 }, idle)
  compactJournalItemRevisionPage(database.db, { keys: 1, rows: 2 }, idle)
  expect(itemRecordSeqs()).toEqual([2, 3, 4, 5, 6])
  Atomics.store(database.compactionActivity, 0, 0n)
  let page
  do {
    page = compactJournalItemRevisionPage(database.db, { keys: 1, rows: 2 }, idle)
  } while (!page.done && page.deleted === 0)
  expect(itemRecordSeqs()).toEqual([2, 5, 6])
})

it('preserves the entire epoch when a distant item contains an unknown field', () => {
  seedOldHistory()
  database.db.exec(`UPDATE journal_outcomes SET value_json = json_set(value_json, '$.future', 1)
    WHERE field = 'items' AND seq = 6`)
  finishCompaction()
  expect(itemRecordSeqs()).toEqual([2, 3, 4, 5, 6])
})
