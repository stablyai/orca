import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import SyncDatabase from '../sqlite/sync-database'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { cwdKey } from './session-search-file-records'
import { requiresWholeRead } from './session-search-file-cursor'
import { SessionSearchIndexWriter } from './session-search-index-writer'
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

// Every assertion here reads through `index.db`, a second connection to the same
// file. That is the whole consistency model: one transaction per file in WAL
// mode, so another handle sees the last committed state and never a session part
// way through being rewritten.

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

/** Fails the nth statement matching `pick`, wherever the writer prepares it. */
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

it('writes a whole read in one transaction', () => {
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

  // One table carries all three; the conversation scope is a column filter over
  // it, which is what the second table used to be.
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
  // The process dies here: the rows only ever existed in this buffer.
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

  // Not one of the 49 rows that were already inserted survived, the previous
  // generation is untouched, and the cursor still describes what is really here.
  expect(counts(index.db)).toEqual(before)
  expect(matches(index.db, 'messages_fts', 'crashedgeneration')).toBe(0)
  expect(matches(index.db, 'messages_fts', 'firstgeneration')).toBe(3)
  expect(store.indexedFile(SYNTHETIC_TRANSCRIPT, null)?.byteOffset).toBe(40)
  expect(errors).toHaveLength(1)
  // The file is owed a re-read, which is the only reason anything was lost.
  expect(store.takeStale().map((candidate) => candidate.file.path)).toEqual([SYNTHETIC_TRANSCRIPT])

  // And the connection is usable again: a transaction left open by the failure
  // would take down every write after it, not just the one that threw.
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

  // The cursor is written last, so this is the crash point that would leave rows
  // no cursor describes: a later append would continue from an offset those rows
  // already cover, and index the same span twice.
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

it('shows a reader on another handle one generation or the other, never a mixture', () => {
  replayTranscriptRead({
    messages: userMessages('firstgeneration', 3),
    outcome: { byteOffset: 40 }
  })
  expect(counts(index.db).messages).toBe(3)

  const write = store.beginWrite(syntheticCandidate(), 'replace', 0)!
  for (const message of userMessages('secondgeneration', 7)) {
    write.add(message)
    // Every point at which the other handle could issue a query mid-read.
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

  expect(counts(index.db).messages).toBe(7)
  expect(matches(index.db, 'messages_fts', 'firstgeneration')).toBe(0)
  expect(matches(index.db, 'messages_fts', 'secondgeneration')).toBe(7)
})

// Four of these fill the 400-char ceiling the two tests below construct.
const CHUNKED_MESSAGE = `chunkedneedle ${'filler '.repeat(12)}nd`

it('leaves the session consistent after every chunk of a file too large for one transaction', () => {
  expect(CHUNKED_MESSAGE.length).toBe(100)
  const writer = new SessionSearchIndexWriter(index.db, 400)
  const write = writer.beginWrite(syntheticCandidate(), 'replace', 0)!
  for (const [position, message] of userMessages(CHUNKED_MESSAGE, 10).entries()) {
    write.add(message)
    const rows = counts(index.db).messages
    // Four messages per chunk, and nothing else reaches the file between them.
    expect(rows).toBe(Math.floor((position + 1) / 4) * 4)
    // Whatever landed is a coherent prefix of this session and answers searches.
    expect(matches(index.db, 'messages_fts', 'chunkedneedle')).toBe(rows)
    if (rows > 0) {
      // The cursor a chunk leaves refuses every append rather than inventing an
      // offset the reader never gave it.
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

  // One conversation turn, three times the ceiling. Checked once per message,
  // this commits all 24,000 characters in a single transaction — the ceiling
  // bounds nothing that a message can exceed on its own.
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

const PROVISIONAL_IDENTITY = {
  sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  cwd: '/repo/app',
  title: 'provisional title',
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-01T10:05:00.000Z'
}

it('names a session on its first chunk, not only when the read ends', () => {
  const writer = new SessionSearchIndexWriter(index.db, 400)
  const write = writer.beginWrite(syntheticCandidate(), 'replace', 0, () => PROVISIONAL_IDENTITY)!
  for (const message of userMessages(CHUNKED_MESSAGE, 10)) {
    write.add(message)
  }

  // The chunks that landed already answer searches, so the session they hang
  // off has to be nameable on another handle before the read ends. This is also
  // the whole record a crash between chunks leaves behind.
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

  // And the decoded session still wins at the end: the mid-read title is
  // provisional, never a value the final commit has to defer to.
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

it('leaves a chunked session unnamed only while the parser has no id yet', () => {
  const writer = new SessionSearchIndexWriter(index.db, 400)
  const write = writer.beginWrite(syntheticCandidate(), 'replace', 0, () => null)!
  for (const message of userMessages(CHUNKED_MESSAGE, 10)) {
    write.add(message)
  }

  // A parser with nothing decoded is not a reason to write a wrong id; the row
  // is still created, and the next chunk fills it in.
  expect(index.db.prepare('SELECT session_id, cwd FROM sessions').get()).toEqual({
    session_id: '',
    cwd: null
  })
})

it('reports a chunk-partial file as held, and as one that must be read whole', () => {
  const writer = new SessionSearchIndexWriter(index.db, 400)
  const write = writer.beginWrite(syntheticCandidate(), 'replace', 0)!
  for (const message of userMessages(CHUNKED_MESSAGE, 10)) {
    write.add(message)
  }

  // Held, with no cursor to continue. Reporting nothing here reads as "never
  // indexed", so a caller asks for whatever read the parse cache offers, the
  // reader picks append, and only a decline heals it a cycle later.
  const held = writer.indexedFile(SYNTHETIC_TRANSCRIPT, null)
  expect(held).not.toBeNull()
  expect(held?.byteOffset).toBeNull()
  expect(requiresWholeRead(held)).toBe(true)
  expect(held?.mtimeMs).toBe(syntheticCandidate().file.mtimeMs)

  // A file this index has never seen is still the other answer, so the two
  // states a caller has to tell apart are distinguishable.
  expect(writer.indexedFile('/never-seen.jsonl', null)).toBeNull()
  expect(requiresWholeRead(null)).toBe(false)

  // And no offset continues it, including the one the chunk recorded.
  for (const offset of [0, -1, 400, 1000]) {
    expect(writer.beginWrite(syntheticCandidate(), 'append', offset)).toBeNull()
  }
})

it('re-reads a chunked file whole when its writer died between chunks', () => {
  const writer = new SessionSearchIndexWriter(index.db, 400)
  const abandoned = writer.beginWrite(syntheticCandidate(), 'replace', 0)!
  for (const message of userMessages(CHUNKED_MESSAGE, 10)) {
    abandoned.add(message)
  }
  expect(counts(index.db).messages).toBe(8)

  // Nothing can continue that prefix, so the only way forward is a whole re-read,
  // and that replaces every row the dead writer left.
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
  expect(counts(index.db)).toMatchObject({ sessions: 1, messages: 1 })
  expect(matches(index.db, 'messages_fts', 'chunkedneedle')).toBe(0)
})

it('stops a chunked read whose file was removed between its chunks', () => {
  const writer = new SessionSearchIndexWriter(index.db, 400)
  const write = writer.beginWrite(syntheticCandidate(), 'replace', 0)!
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

  // Not one row of the removed source came back. The read stopped at the first
  // refusal rather than reopening a transaction it already knows will roll back,
  // once for every message left in a file that may be a hundred megabytes.
  expect(opened).toBe(1)
  expect(counts(index.db)).toMatchObject({ sessions: 0, messages: 0, files: 0, full: 0 })
})

it('fences a first-ever read whose file was removed before it committed', () => {
  const candidate = syntheticCandidate({ path: '/never-indexed.jsonl' })
  const write = store.beginWrite(candidate, 'replace', 0)!
  for (const message of userMessages('removedbeforefirstcommit', 3)) {
    write.add(message)
  }
  // The path was never indexed, so there is no cursor for the removal to move.
  // PR 3's retirement sweep removes exactly these: paths the index deferred over
  // budget and never wrote, while the registered consumer is fed concurrently.
  store.removeFile('/never-indexed.jsonl')

  expect(write.commit({ session: syntheticSession(), byteOffset: 300, incomplete: false })).toBe(
    false
  )
  expect(counts(index.db)).toMatchObject({ sessions: 0, messages: 0, files: 0, full: 0 })
})

it('replaces the previous generation without ever showing both', () => {
  replayTranscriptRead({ messages: userMessages('firstgeneration', 10) })
  replayTranscriptRead({ messages: userMessages('secondgeneration', 10) })

  expect(counts(index.db)).toMatchObject({
    sessions: 1,
    messages: 10,
    full: 10
  })
  expect(matches(index.db, 'messages_fts', 'firstgeneration')).toBe(0)
  expect(matches(index.db, 'messages_fts', 'secondgeneration')).toBe(10)
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
    files: 0,
    full: 0
  })
  expect(store.pendingFileCount).toBe(1)
  expect(errors).toEqual([])
})

it('closes twice without turning the second call into an error', () => {
  store.close()
  // node:sqlite throws ERR_INVALID_STATE on a second close of one handle, and a
  // store is closed both by whoever owns it and by a teardown that cannot know.
  expect(() => store.close()).not.toThrow()
  store = new SessionSearchStore(index.path, (error) => errors.push(error))
})
