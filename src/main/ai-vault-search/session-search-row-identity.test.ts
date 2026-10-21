import { afterEach, beforeEach, expect, it } from 'vitest'
import type SyncDatabase from '../sqlite/sync-database'
import { deleteExpiredSearchFiles } from './session-search-retention-delete'
import {
  openSessionSearchIndexFile,
  syntheticCandidate,
  syntheticSession,
  userMessages,
  type SessionSearchIndexFile
} from './session-search-index-test-fixture'
import { SessionSearchStore } from './session-search-store'

// A session row id outlives the row: it names the rows in `messages` until a
// retention drain has walked all of them, which takes many transactions. These
// tests are about what may be handed that id in the meantime.

let index: SessionSearchIndexFile
let store: SessionSearchStore
let errors: unknown[]

beforeEach(async () => {
  index = await openSessionSearchIndexFile('ss-row-identity')
  errors = []
  store = new SessionSearchStore(index.path, (error) => errors.push(error))
})

afterEach(async () => {
  store.close()
  await index.close()
})

const OLD_MTIME = 1_000
const LIVE_MTIME = 1_000_000
const LIVE_PATH = '/live.jsonl'

function count(db: SyncDatabase, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
}

/** Rows a search would return for a term: the join every retrieval makes. */
function matches(db: SyncDatabase, term: string): number {
  return (
    db
      .prepare(
        `SELECT count(*) AS n FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_row_id WHERE messages_fts MATCH ?`
      )
      .get(term) as { n: number }
  ).n
}

function indexFile(path: string, mtimeMs: number, text: string, rows: number): void {
  const write = store.beginWrite(syntheticCandidate({ path, mtimeMs }), 'replace', 0)!
  for (const message of userMessages(text, rows)) {
    write.add(message)
  }
  expect(write.commit({ session: syntheticSession(), byteOffset: 50, incomplete: false })).toBe(
    true
  )
}

it('never hands a live session the rows of a purged one', async () => {
  // Two expiring transcripts, each large enough that reclaiming their rows takes
  // several transactions, and one live transcript the parser decoded no session
  // from — so it holds a cursor and no session row of its own.
  indexFile('/old-a.jsonl', OLD_MTIME, 'purgedneedle', 400)
  indexFile('/old-b.jsonl', OLD_MTIME, 'purgedneedle', 400)
  const live = syntheticCandidate({ path: LIVE_PATH, mtimeMs: LIVE_MTIME })
  const opening = store.beginWrite(live, 'replace', 0)!
  opening.add(userMessages('excluded', 1)[0]!)
  expect(opening.commit({ session: null, byteOffset: 50, incomplete: false })).toBe(true)

  let appended = false
  await deleteExpiredSearchFiles(
    index.db,
    LIVE_MTIME,
    () => false,
    async () => {
      // The window: both expiring sessions are cut loose, most of their rows are
      // still on disk, and the live transcript grows. The append is legitimate —
      // it continues this index's own cursor — and it needs a session row.
      if (appended || count(index.db, 'sessions') > 0) {
        return
      }
      appended = true
      const write = store.beginWrite(live, 'append', 50)!
      for (const message of userMessages('liveneedle', 2)) {
        write.add(message)
      }
      expect(
        write.commit({ session: syntheticSession(), byteOffset: 120, incomplete: false })
      ).toBe(true)
    }
  )

  expect(appended).toBe(true)
  // Reusing a freed id would adopt whatever of that session's rows the drain had
  // not reached, and put them behind a live session no purge will visit again.
  expect(matches(index.db, 'purgedneedle')).toBe(0)
  expect(matches(index.db, 'liveneedle')).toBe(2)
  expect(count(index.db, 'messages')).toBe(2)
  expect(errors).toEqual([])
})

it('never reissues a session row id a delete freed', () => {
  for (const path of ['/a.jsonl', '/b.jsonl', '/c.jsonl']) {
    indexFile(path, OLD_MTIME, 'seeded', 1)
  }
  const before = (index.db.prepare('SELECT max(id) AS id FROM sessions').get() as { id: number }).id
  index.db.exec('DELETE FROM sessions')

  indexFile('/d.jsonl', OLD_MTIME, 'seeded', 1)
  expect((index.db.prepare('SELECT id FROM sessions').get() as { id: number }).id).toBeGreaterThan(
    before
  )
})
