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

it('compacts old item revisions page by page, resuming where the last page committed', () => {
  database.transaction((db) => {
    // History written by a build that kept every revision.
    db.exec('DROP TRIGGER journal_outcome_item_supersede')
    const generation = Number(
      db
        .prepare('INSERT INTO journal_outcome_generations (session_id, epoch) VALUES (?, ?)')
        .run('old', 'old-epoch').lastInsertRowid
    )
    const insert = db.prepare(`INSERT INTO journal_outcomes
      (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
      VALUES (?, ?, ?, ?, 3, 'o', '{}', 0)`)
    for (const seq of [1, 2, 3, 4, 5, 6]) {
      insert.run(generation, seq, 'items', '"a"')
      insert.run(generation, seq, 'itemFences', '"a"')
    }
    for (const seq of [2, 3]) {
      insert.run(generation, seq, 'items', '"b"')
    }
  })

  let pages = 0
  while (!compactJournalItemRevisionPage(database.db, { keys: 1, rows: 2 }).done) {
    pages += 1
  }

  expect(pages).toBe(3)
  expect(itemRecordSeqs()).toEqual([1, 6, 2, 3])
  expect(itemRecordSeqs('itemFences')).toEqual([1, 2, 3, 4, 5, 6])
  expect(compactJournalItemRevisionPage(database.db, { keys: 1, rows: 2 })).toEqual({
    done: true,
    keys: 0,
    deleted: 0
  })
})
