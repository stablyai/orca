import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import SyncDatabase from '../sqlite/sync-database'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { cwdKey } from './session-search-file-records'
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

it('publishes all rows from a completed whole read', () => {
  replayTranscriptRead({ messages: userMessages('needle text', 300) })

  const after = counts(index.db)
  expect(after.sessions).toBe(1)
  expect(after.messages).toBe(300)
  expect(after.full).toBe(300)
  expect(errors).toEqual([])
})

it('files every row in one FTS table, under the column its role owns', () => {
  replayTranscriptRead({
    messages: [
      { role: 'user', text: 'alpha question', timestamp: null },
      { role: 'assistant', text: 'beta answer', timestamp: null },
      { role: 'tool', text: 'gamma tool output', timestamp: null }
    ]
  })

  expect(counts(index.db).full).toBe(3)
  expect(matches(index.db, 'messages_fts', 'gamma')).toBe(1)
  expect(matches(index.db, 'messages_fts', '{user_text assistant_text}: gamma')).toBe(0)
  expect(matches(index.db, 'messages_fts', '{user_text assistant_text}: beta')).toBe(1)
})

it('leaves the index exactly as it found it when a read never finishes', () => {
  const write = store.beginWrite(syntheticCandidate(), 'replace', 0)!
  for (const message of userMessages('neverfinished', 200)) {
    write.add(message)
  }
  expect(counts(index.db)).toMatchObject({
    sessions: 0,
    messages: 0,
    files: 0
  })
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

it('holds the ceiling against a single message larger than it', () => {
  const writer = new SessionSearchIndexWriter(index.db, 8000)
  const write = writer.beginWrite(syntheticCandidate(), 'replace', 0, named)!
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

  // A single message exceeds the transaction ceiling; split it by row before committing.
  write.add({ role: 'assistant', text: 'a'.repeat(24_000), timestamp: null })
  vi.restoreAllMocks()

  expect(opened).toBe(3)
  expect(counts(index.db).messages).toBe(3)
  expect(
    write.commit({
      session: syntheticSession(),
      byteOffset: 4096,
      incomplete: false
    })
  ).toBe(true)
  expect(counts(index.db)).toMatchObject({ sessions: 1, messages: 3 })
})

it('names a session on its first chunk, not only when the read ends', () => {
  const writer = new SessionSearchIndexWriter(index.db, 400)
  const write = writer.beginWrite(syntheticCandidate(), 'replace', 0, named)!
  for (const message of userMessages(CHUNKED_MESSAGE, 10)) {
    write.add(message)
  }

  expect(counts(index.db).messages).toBe(8)
  expect(
    index.db.prepare('SELECT session_id, cwd, cwd_key, title, created_at FROM sessions').get()
  ).toEqual({
    session_id: PROVISIONAL_IDENTITY.sessionId,
    cwd: '/repo/app',
    cwd_key: cwdKey('/repo/app'),
    title: 'provisional title',
    created_at: '2026-05-01T10:00:00.000Z'
  })

  expect(
    write.commit({
      session: syntheticSession({ title: 'the settled title' }),
      byteOffset: 4096,
      incomplete: false
    })
  ).toBe(true)
  expect(index.db.prepare('SELECT title FROM sessions').get()).toEqual({
    title: 'the settled title'
  })
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

it('starts chunking only once the parser has an id to name the session with', () => {
  const writer = new SessionSearchIndexWriter(index.db, 400)
  let decoded: typeof PROVISIONAL_IDENTITY | null = null
  const write = writer.beginWrite(syntheticCandidate(), 'replace', 0, () => decoded)!
  for (const message of userMessages(CHUNKED_MESSAGE, 4)) {
    write.add(message)
  }
  expect(counts(index.db).messages).toBe(0)

  decoded = PROVISIONAL_IDENTITY
  write.add(userMessages(CHUNKED_MESSAGE, 1)[0]!)

  expect(counts(index.db).messages).toBe(5)
  expect(index.db.prepare('SELECT session_id, cwd FROM sessions').get()).toEqual({
    session_id: PROVISIONAL_IDENTITY.sessionId,
    cwd: '/repo/app'
  })
})

it('reports a chunk-partial file as held, and as one that must be read whole', () => {
  const writer = new SessionSearchIndexWriter(index.db, 400)
  const write = writer.beginWrite(syntheticCandidate(), 'replace', 0, named)!
  for (const message of userMessages(CHUNKED_MESSAGE, 10)) {
    write.add(message)
  }

  const held = writer.indexedFile(SYNTHETIC_TRANSCRIPT, null)
  expect(held).not.toBeNull()
  expect(held?.byteOffset).toBeNull()
  expect(requiresWholeRead(held)).toBe(true)
  expect(held?.mtimeMs).toBe(syntheticCandidate().file.mtimeMs)

  expect(writer.indexedFile('/never-seen.jsonl', null)).toBeNull()
  expect(requiresWholeRead(null)).toBe(false)

  for (const offset of [0, -1, 400, 1000]) {
    expect(writer.beginWrite(syntheticCandidate(), 'append', offset)).toBeNull()
  }
})

it('re-reads a chunked file whole when its writer died between chunks', async () => {
  const writer = new SessionSearchIndexWriter(index.db, 400)
  const abandoned = writer.beginWrite(syntheticCandidate(), 'replace', 0, named)!
  for (const message of userMessages(CHUNKED_MESSAGE, 10)) {
    abandoned.add(message)
  }
  expect(counts(index.db).messages).toBe(8)

  expect(requiresWholeRead(writer.indexedFile(SYNTHETIC_TRANSCRIPT, null))).toBe(true)
  const replacement = writer.beginWrite(syntheticCandidate(), 'replace', 0)!
  replacement.add(userMessages('wholereread', 1)[0]!)
  expect(
    replacement.commit({
      session: syntheticSession(),
      byteOffset: 4096,
      incomplete: false
    })
  ).toBe(true)
  expect(counts(index.db)).toMatchObject({ sessions: 1, messages: 9 })
  expect(matches(index.db, 'messages_fts', 'chunkedneedle')).toBe(0)
  await deleteExpiredSearchFiles(index.db, null, () => false)
  expect(counts(index.db)).toMatchObject({ sessions: 1, messages: 1 })
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

it('replaces the previous generation without ever showing both', async () => {
  const candidate = syntheticCandidate()
  replayTranscriptRead({ candidate, messages: userMessages('firstgeneration', 10) })
  replayTranscriptRead({
    candidate: syntheticCandidate({ mtimeMs: candidate.file.mtimeMs + 1 }),
    messages: userMessages('secondgeneration', 10)
  })

  expect(matches(index.db, 'messages_fts', 'firstgeneration')).toBe(0)
  expect(matches(index.db, 'messages_fts', 'secondgeneration')).toBe(10)
  await vi.waitFor(() => {
    expect(counts(index.db)).toMatchObject({ sessions: 1, messages: 10, full: 10 })
  })
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

it('drains what a replace cut loose without being asked', async () => {
  const candidate = syntheticCandidate()
  replayTranscriptRead({ candidate, messages: userMessages('firstgeneration', 200) })
  replayTranscriptRead({
    candidate: syntheticCandidate({ mtimeMs: candidate.file.mtimeMs + 1 }),
    messages: userMessages('secondgeneration', 3)
  })

  expect(matches(index.db, 'messages_fts', 'firstgeneration')).toBe(0)
  await vi.waitFor(() => {
    expect(counts(index.db)).toMatchObject({ sessions: 1, messages: 3, full: 3 })
  })
  expect(errors).toEqual([])
})

it('continues a session across an append rather than replaying it', () => {
  replayTranscriptRead({
    messages: userMessages('openingturn', 3),
    outcome: { byteOffset: 40 }
  })
  replayTranscriptRead({
    messages: userMessages('laterturn', 2),
    mode: 'append',
    previousByteOffset: 40,
    outcome: { byteOffset: 90 }
  })

  expect(counts(index.db)).toMatchObject({ sessions: 1, messages: 5 })
  expect(matches(index.db, 'messages_fts', 'openingturn')).toBe(3)
  expect(matches(index.db, 'messages_fts', 'laterturn')).toBe(2)
  expect(store.indexedFile(SYNTHETIC_TRANSCRIPT, null)?.byteOffset).toBe(90)
})

it('stops answering for a removed file the moment it is removed', () => {
  replayTranscriptRead({ messages: userMessages('removedneedle', 3) })
  store.removeFile(SYNTHETIC_TRANSCRIPT)

  expect(counts(index.db)).toMatchObject({
    sessions: 0,
    messages: 0,
    files: 0,
    full: 0
  })
  expect(matches(index.db, 'messages_fts', 'removedneedle')).toBe(0)
})

it('writes nothing for an incomplete read and owes the file a whole re-read', () => {
  replayTranscriptRead({
    messages: userMessages('incompleteread', 300),
    outcome: { incomplete: true }
  })

  expect(counts(index.db)).toMatchObject({
    sessions: 0,
    messages: 0,
    full: 0
  })
  expect(index.db.prepare('SELECT byte_offset, state, fail_count FROM files').get()).toMatchObject({
    byte_offset: 0,
    state: 'failed',
    fail_count: 1
  })
  expect(errors).toEqual([])
})

it('exposes the handle a composed reader queries through', () => {
  replayTranscriptRead({ messages: userMessages('composedreader', 3) })

  expect(store.connection.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 3 })
})

it('closes twice without turning the second call into an error', () => {
  store.close()
  expect(() => store.close()).not.toThrow()
  store = new SessionSearchStore(index.path, (error) => errors.push(error))
})
