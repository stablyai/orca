import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetTranscriptConsumersForTests } from '../ai-vault/transcripts/session-transcript-consumers'
import SyncDatabase from '../sqlite/sync-database'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { requiresWholeRead } from './session-search-file-cursor'
import { SessionSearchIndexWriter } from './session-search-index-writer'
import { deleteExpiredSearchFiles } from './session-search-retention-delete'
import {
  openSessionSearchIndexFile,
  replayTranscriptRead,
  syntheticCandidate,
  syntheticSession,
  SYNTHETIC_TRANSCRIPT,
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

function failOnStatement(pick: (sql: string) => boolean, nth: number): void {
  const prepare = SyncDatabase.prototype.prepare
  let seen = 0
  vi.spyOn(SyncDatabase.prototype, 'prepare').mockImplementation(function (
    this: SyncDatabase,
    sql: string
  ) {
    if (pick(sql) && ++seen === nth) {
      throw new Error('index write crashed mid transaction')
    }
    return prepare.call(this, sql)
  })
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

it('indexes conversation rows and excludes tool output', () => {
  replayTranscriptRead({
    messages: [
      { role: 'user', text: 'alpha question', timestamp: null },
      { role: 'assistant', text: 'beta answer', timestamp: null },
      { role: 'tool', text: 'gamma tool output', timestamp: null }
    ]
  })

  expect(counts(index.db).full).toBe(2)
  expect(matches(index.db, 'messages_fts', 'gamma')).toBe(0)
  expect(matches(index.db, 'messages_fts', '{user_text assistant_text}: gamma')).toBe(0)
  expect(matches(index.db, 'messages_fts', '{user_text assistant_text}: beta')).toBe(1)
})

it('rolls a whole file back when a write throws part way through its transaction', () => {
  replayTranscriptRead({
    messages: userMessages('firstgeneration', 3),
    outcome: { byteOffset: 40 }
  })
  const before = counts(index.db)

  failOnStatement((sql) => sql.startsWith('INSERT INTO messages('), 50)
  replayTranscriptRead({
    messages: userMessages('crashedgeneration', 100),
    outcome: { byteOffset: 900 }
  })
  vi.restoreAllMocks()

  expect(counts(index.db)).toEqual(before)
  expect(matches(index.db, 'messages_fts', 'crashedgeneration')).toBe(0)
  expect(matches(index.db, 'messages_fts', 'firstgeneration')).toBe(3)
  expect(store.indexedFile(SYNTHETIC_TRANSCRIPT, null)?.byteOffset).toBe(40)
  expect(errors).toHaveLength(1)
  expect(
    index.db.prepare('SELECT state, fail_count FROM files WHERE path = ?').get(SYNTHETIC_TRANSCRIPT)
  ).toMatchObject({ state: 'failed', fail_count: 1 })

  replayTranscriptRead({
    messages: userMessages('afterthecrash', 2),
    outcome: { byteOffset: 900 }
  })
  expect(matches(index.db, 'messages_fts', 'afterthecrash')).toBe(2)
  expect(store.indexedFile(SYNTHETIC_TRANSCRIPT, null)?.byteOffset).toBe(900)
})

it('takes the rows back when recording the cursor is what fails', () => {
  replayTranscriptRead({
    messages: userMessages('firstgeneration', 3),
    outcome: { byteOffset: 40 }
  })

  // Fail the cursor write to prove rows cannot commit without the offset that describes them.
  failOnStatement((sql) => sql.startsWith('INSERT INTO files('), 1)
  replayTranscriptRead({
    messages: userMessages('crashedgeneration', 5),
    outcome: { byteOffset: 900 }
  })
  vi.restoreAllMocks()

  expect(counts(index.db)).toMatchObject({ sessions: 1, messages: 3 })
  expect(matches(index.db, 'messages_fts', 'firstgeneration')).toBe(3)
  expect(matches(index.db, 'messages_fts', 'crashedgeneration')).toBe(0)
  expect(store.indexedFile(SYNTHETIC_TRANSCRIPT, null)?.byteOffset).toBe(40)
})

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

const CHUNKED_MESSAGE = `chunkedneedle ${'filler '.repeat(12)}nd`

const PROVISIONAL_IDENTITY = {
  sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  cwd: '/repo/app',
  title: 'provisional title',
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-01T10:05:00.000Z'
}

const named = (): typeof PROVISIONAL_IDENTITY => PROVISIONAL_IDENTITY

it('leaves the session consistent after every chunk of a file too large for one transaction', () => {
  expect(CHUNKED_MESSAGE.length).toBe(100)
  const writer = new SessionSearchIndexWriter(index.db, 400)
  const write = writer.beginWrite(syntheticCandidate(), 'replace', 0, named)!
  for (const [position, message] of userMessages(CHUNKED_MESSAGE, 10).entries()) {
    write.add(message)
    const rows = counts(index.db).messages
    expect(rows).toBe(Math.floor((position + 1) / 4) * 4)
    expect(matches(index.db, 'messages_fts', 'chunkedneedle')).toBe(rows)
    if (rows > 0) {
      expect(requiresWholeRead(writer.indexedFile(SYNTHETIC_TRANSCRIPT, null))).toBe(true)
      expect(writer.beginWrite(syntheticCandidate(), 'append', 0)).toBeNull()
    }
  }
  expect(counts(index.db).messages).toBe(8)

  expect(
    write.commit({
      session: syntheticSession(),
      byteOffset: 4096,
      incomplete: false
    })
  ).toBe(true)
  expect(counts(index.db)).toMatchObject({
    sessions: 1,
    messages: 10,
    full: 10
  })
  expect(writer.indexedFile(SYNTHETIC_TRANSCRIPT, null)?.byteOffset).toBe(4096)
})

it('commits a whole-file read over the ceiling in one transaction, never a chunk', () => {
  const writer = new SessionSearchIndexWriter(index.db, 400)
  const write = writer.beginWrite(syntheticCandidate(), 'replace', 0)!
  const exec = SyncDatabase.prototype.exec
  let opened = 0
  vi.spyOn(SyncDatabase.prototype, 'exec').mockImplementation(function (
    this: SyncDatabase,
    sql: string
  ) {
    if (sql === 'BEGIN IMMEDIATE') {
      opened += 1
    }
    exec.call(this, sql)
  })

  for (const message of userMessages(CHUNKED_MESSAGE, 10)) {
    write.add(message)
    expect(counts(index.db)).toMatchObject({ sessions: 0, messages: 0, files: 0 })
  }
  expect(write.commit({ session: syntheticSession(), byteOffset: 4096, incomplete: false })).toBe(
    true
  )
  vi.restoreAllMocks()

  expect(opened).toBe(1)
  expect(counts(index.db)).toMatchObject({ sessions: 1, messages: 10, full: 10 })
  expect(writer.indexedFile(SYNTHETIC_TRANSCRIPT, null)?.byteOffset).toBe(4096)
})

it('stops a chunked read whose file was removed between its chunks', () => {
  const writer = new SessionSearchIndexWriter(index.db, 400)
  const write = writer.beginWrite(syntheticCandidate(), 'replace', 0, named)!
  const messages = userMessages(CHUNKED_MESSAGE, 10)
  for (const message of messages.slice(0, 4)) {
    write.add(message)
  }
  expect(counts(index.db).messages).toBe(4)

  writer.removeFile(SYNTHETIC_TRANSCRIPT)
  const exec = SyncDatabase.prototype.exec
  let opened = 0
  vi.spyOn(SyncDatabase.prototype, 'exec').mockImplementation(function (
    this: SyncDatabase,
    sql: string
  ) {
    if (sql === 'BEGIN IMMEDIATE') {
      opened += 1
    }
    exec.call(this, sql)
  })
  for (const message of messages.slice(4)) {
    write.add(message)
  }
  expect(write.commit({ session: syntheticSession(), byteOffset: 4096, incomplete: false })).toBe(
    false
  )
  vi.restoreAllMocks()

  // Fence once instead of reopening doomed transactions for every remaining message.
  expect(opened).toBe(1)
  expect(counts(index.db)).toMatchObject({ sessions: 0, messages: 0, files: 0, full: 0 })
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

it('replaces a generation by cutting the old one loose, not by deleting it inline', async () => {
  const writer = new SessionSearchIndexWriter(index.db)
  const first = writer.beginWrite(syntheticCandidate(), 'replace', 0)!
  for (const message of userMessages('firstgeneration', 200)) {
    first.add(message)
  }
  expect(first.commit({ session: syntheticSession(), byteOffset: 100, incomplete: false })).toBe(
    true
  )
  const before = index.db.prepare('SELECT id FROM sessions').get() as { id: number }
  expect(counts(index.db).messages).toBe(200)

  const second = writer.beginWrite(syntheticCandidate(), 'replace', 0)!
  for (const message of userMessages('secondgeneration', 3)) {
    second.add(message)
  }
  expect(second.commit({ session: syntheticSession(), byteOffset: 200, incomplete: false })).toBe(
    true
  )

  // Replacement hides old rows through the session join; reclamation happens after commit.
  expect(counts(index.db)).toMatchObject({ sessions: 1, messages: 203, full: 203 })
  expect(matches(index.db, 'messages_fts', 'firstgeneration')).toBe(0)
  expect(matches(index.db, 'messages_fts', 'secondgeneration')).toBe(3)

  // AUTOINCREMENT prevents orphaned messages from attaching to a reused session id.
  const after = index.db.prepare('SELECT id FROM sessions').get() as { id: number }
  expect(after.id).toBeGreaterThan(before.id)
  expect(index.db.prepare('SELECT session_row_id FROM files').get()).toEqual({
    session_row_id: after.id
  })

  await deleteExpiredSearchFiles(index.db, null, () => false)
  expect(counts(index.db)).toMatchObject({ sessions: 1, messages: 3, full: 3 })
})
