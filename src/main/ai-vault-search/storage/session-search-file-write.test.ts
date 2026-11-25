import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetTranscriptConsumersForTests } from '../../ai-vault/transcripts/session-transcript-consumers'
import '../../sqlite/sync-database'
import type SyncDatabase from '../../sqlite/sync-database'
import { registerSessionSearchIndexConsumer } from '../indexing/session-search-index-consumer'
import './session-search-file-cursor'
import './session-search-index-writer'
import './session-search-retention-delete'
import {
  openSessionSearchIndexFile,
  replayTranscriptRead,
  syntheticCandidate,
  syntheticSession,
  userMessages,
  type SessionSearchIndexFile
} from './session-search-index-test-fixture'
import { SessionSearchStore } from './session-search-store'

// Read through a second connection to verify only committed transactions become visible.

let index: SessionSearchIndexFile
let store: SessionSearchStore
let errors: unknown[]

beforeEach(async () => {
  index = await openSessionSearchIndexFile('ss-file-write')
  errors = []
  store = new SessionSearchStore(index.path, (error) => errors.push(error))
  registerSessionSearchIndexConsumer(store)
})

afterEach(async () => {
  vi.restoreAllMocks()
  resetTranscriptConsumersForTests()
  store.close()
  await index.close()
})

function matches(db: SyncDatabase, table: string, term: string): number {
  return (
    db
      .prepare(
        `SELECT count(*) AS n FROM ${table} JOIN messages m ON m.id = ${table}.rowid
         JOIN sessions s ON s.id = m.session_row_id WHERE ${table} MATCH ?`
      )
      .get(term) as { n: number }
  ).n
}

function counts(db: SyncDatabase): Record<string, number> {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n
  return {
    sessions: one('SELECT count(*) AS n FROM sessions'),
    messages: one('SELECT count(*) AS n FROM messages'),
    files: one('SELECT count(*) AS n FROM files'),
    full: one('SELECT count(*) AS n FROM messages_fts')
  }
}

it('shows a reader on another handle one generation or the other, never a mixture', async () => {
  replayTranscriptRead({
    messages: userMessages('firstgeneration', 3),
    outcome: { byteOffset: 40 }
  })
  expect(counts(index.db).messages).toBe(3)

  const write = store.beginWrite(syntheticCandidate(), 'replace', 0)!
  for (const message of userMessages('secondgeneration', 7)) {
    write.add(message)
    expect(counts(index.db).messages).toBe(3)
    expect(matches(index.db, 'messages_fts', 'secondgeneration')).toBe(0)
  }
  expect(
    write.commit({
      session: syntheticSession(),
      byteOffset: 900,
      incomplete: false
    })
  ).toBe(true)

  expect(matches(index.db, 'messages_fts', 'firstgeneration')).toBe(0)
  expect(matches(index.db, 'messages_fts', 'secondgeneration')).toBe(7)
  // Replaced messages become unreachable at commit and are reclaimed asynchronously.
  expect(counts(index.db).messages).toBe(10)
  await vi.waitFor(() => {
    expect(counts(index.db).messages).toBe(7)
  })
})

it('fences a first-ever read whose file was removed before it committed', () => {
  const candidate = syntheticCandidate({ path: '/never-indexed.jsonl' })
  const write = store.beginWrite(candidate, 'replace', 0)!
  for (const message of userMessages('removedbeforefirstcommit', 3)) {
    write.add(message)
  }
  store.removeFile('/never-indexed.jsonl')

  expect(write.commit({ session: syntheticSession(), byteOffset: 300, incomplete: false })).toBe(
    false
  )
  expect(counts(index.db)).toMatchObject({ sessions: 0, messages: 0, files: 0, full: 0 })
})
