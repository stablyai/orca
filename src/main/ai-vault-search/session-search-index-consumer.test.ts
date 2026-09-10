import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexFile,
  replayTranscriptRead,
  syntheticCandidate,
  syntheticSession,
  SYNTHETIC_TRANSCRIPT,
  userMessages,
  type SessionSearchIndexFile
} from './session-search-staged-write-test-fixture'
import { SessionSearchStore, STALE_PATH_LIMIT } from './session-search-store'

let index: SessionSearchIndexFile
let store: SessionSearchStore
let errors: unknown[]

beforeEach(async () => {
  index = await openSessionSearchIndexFile('ss-index-consumer')
  errors = []
  store = new SessionSearchStore(index.path, (error) => errors.push(error))
  registerSessionSearchIndexConsumer(store)
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  store.close()
  await index.close()
})

function visibleMessages(): number {
  return (index.db.prepare('SELECT count(*) AS n FROM visible_messages').get() as { n: number }).n
}

function cursor(): number | undefined {
  return store.indexedFile(SYNTHETIC_TRANSCRIPT, null)?.byteOffset
}

it('appends onto its own cursor and carries the content hash forward', async () => {
  replayTranscriptRead({ messages: userMessages('first half', 3), outcome: { byteOffset: 100 } })
  await store.settled()
  const first = index.db
    .prepare('SELECT content_hash AS hash, content_hash_count AS count FROM visible_sessions')
    .get() as { hash: string; count: number }

  replayTranscriptRead({
    mode: 'append',
    previousByteOffset: 100,
    messages: userMessages('second half', 2),
    outcome: { byteOffset: 220 }
  })
  await store.settled()

  expect(visibleMessages()).toBe(5)
  expect(cursor()).toBe(220)
  const second = index.db
    .prepare('SELECT content_hash AS hash, content_hash_count AS count FROM visible_sessions')
    .get() as { hash: string; count: number }
  expect(second.count).toBe(first.count + 2)
  expect(second.hash).not.toBe(first.hash)
  expect(store.takeStale()).toEqual([])
})

it('appends onto a file it read through and decoded no session from', async () => {
  // An excluded Codex worker transcript: read through, nothing to index, and
  // still growing. Its cursor is sound, so a re-read of the whole file every
  // pass buys nothing.
  replayTranscriptRead({
    messages: userMessages('excluded span', 3),
    outcome: { session: null, byteOffset: 100 }
  })
  await store.settled()
  expect(cursor()).toBe(100)
  expect(store.takeStale()).toEqual([])

  replayTranscriptRead({
    mode: 'append',
    previousByteOffset: 100,
    messages: userMessages('decoded at last', 2),
    outcome: { byteOffset: 220 }
  })
  await store.settled()

  expect(visibleMessages()).toBe(2)
  expect(cursor()).toBe(220)
  expect(store.takeStale()).toEqual([])
})

it('declines an append that starts past its own cursor and records the file', async () => {
  replayTranscriptRead({ messages: userMessages('indexed span', 3), outcome: { byteOffset: 100 } })
  await store.settled()

  // The session list read further than this index did, so the appended span
  // continues from bytes the index never saw.
  replayTranscriptRead({
    mode: 'append',
    previousByteOffset: 900,
    messages: userMessages('unseen span', 4),
    outcome: { byteOffset: 1200 }
  })
  await store.settled()

  expect(visibleMessages()).toBe(3)
  expect(cursor()).toBe(100)
  expect(store.takeStale().map((candidate) => candidate.file.path)).toEqual([SYNTHETIC_TRANSCRIPT])
})

it('declines a file whose identity changed under the same path', async () => {
  const original = syntheticCandidate({ dev: 1, ino: 10 })
  replayTranscriptRead({
    candidate: original,
    messages: userMessages('original file', 2),
    outcome: { byteOffset: 100 }
  })
  await store.settled()

  replayTranscriptRead({
    candidate: syntheticCandidate({ dev: 1, ino: 77 }),
    mode: 'append',
    previousByteOffset: 100,
    messages: userMessages('replacement file', 2),
    outcome: { byteOffset: 200 }
  })
  await store.settled()

  expect(visibleMessages()).toBe(2)
  expect(store.takeStale()).toHaveLength(1)
})

it('never advances the cursor for an incomplete read', async () => {
  replayTranscriptRead({ messages: userMessages('complete span', 3), outcome: { byteOffset: 100 } })
  await store.settled()

  replayTranscriptRead({
    mode: 'append',
    previousByteOffset: 100,
    messages: userMessages('partial span', 5),
    outcome: { byteOffset: 400, incomplete: true }
  })
  await store.settled()
  await store.purgeOlderThan(null)

  expect(visibleMessages()).toBe(3)
  expect(cursor()).toBe(100)
  expect((index.db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n).toBe(3)
  expect(store.takeStale()).toHaveLength(1)
})

it('indexes nothing at all from a read that was incomplete from the start', async () => {
  replayTranscriptRead({
    messages: userMessages('unreachable', 4),
    outcome: { byteOffset: 0, incomplete: true }
  })
  await store.settled()
  await store.purgeOlderThan(null)

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 })
  expect(cursor()).toBeUndefined()
})

it('drops a file whose parser returned no session', async () => {
  replayTranscriptRead({ messages: userMessages('was indexed', 3), outcome: { byteOffset: 100 } })
  await store.settled()

  replayTranscriptRead({
    messages: userMessages('now rejected', 2),
    outcome: { session: null, byteOffset: 300 }
  })
  await store.settled()
  await store.purgeOlderThan(null)

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 })
  // The file is still read through, so a later scan does not re-read it.
  expect(cursor()).toBe(300)
})

it('stages nothing for a source whose parser cannot reach the channel', async () => {
  // An OpenCode SQLite candidate decodes in a worker, so every read of it is
  // incomplete; opening a batch per scan would tombstone rows forever.
  const candidate = {
    ...syntheticCandidate({ path: '/opencode/opencode.db#session-1' }),
    agent: 'opencode' as const
  }
  replayTranscriptRead({
    candidate,
    messages: [],
    outcome: { byteOffset: 0, incomplete: true }
  })
  await store.settled()

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  expect(index.db.prepare('SELECT count(*) AS n FROM search_pending_deletes').get()).toEqual({
    n: 0
  })
  expect(store.takeStale()).toEqual([])
})

it('ignores a candidate older than the retention cutoff', async () => {
  store.setRetentionCutoffMs(Date.now())
  replayTranscriptRead({ messages: userMessages('too old', 3) })
  await store.settled()

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  expect(store.takeStale()).toEqual([])
})

it('stops writing while the store refuses writes, but remembers what it skipped', async () => {
  store.setAcceptingWrites(false)
  replayTranscriptRead({ messages: userMessages('paused', 3) })
  await store.settled()

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  expect(errors).toEqual([])
  // A pause is exactly the window in which every read is declined. Forgetting
  // them would leave the whole paused span unindexed with nothing to replay it.
  expect(store.takeStale().map((candidate) => candidate.file.path)).toEqual([SYNTHETIC_TRANSCRIPT])
})

it('keeps the paused re-read set when the retention window is reconfigured', async () => {
  store.setAcceptingWrites(false)
  replayTranscriptRead({ messages: userMessages('paused', 2) })
  await store.settled()
  expect(store.pendingFileCount).toBe(1)

  // Retention is the only thing allowed to prune this set, and this candidate
  // is inside the new window.
  store.setRetentionCutoffMs(syntheticCandidate().file.mtimeMs - 1000)
  expect(store.pendingFileCount).toBe(1)

  // A cutoff that really does exclude it still prunes.
  store.setRetentionCutoffMs(Date.now())
  expect(store.pendingFileCount).toBe(0)
})

it('drops the oldest record rather than growing without a bound, and says so', () => {
  store.setAcceptingWrites(false)
  for (let index = 0; index < STALE_PATH_LIMIT + 5; index++) {
    store.markStale(syntheticCandidate({ path: `/transcript-${index}.jsonl` }))
  }

  expect(store.pendingFileCount).toBe(STALE_PATH_LIMIT)
  expect(store.droppedPendingFileCount).toBe(5)
  const kept = store.takeStale().map((candidate) => candidate.file.path)
  expect(kept).not.toContain('/transcript-0.jsonl')
  expect(kept).toContain(`/transcript-${STALE_PATH_LIMIT + 4}.jsonl`)
})

it('keeps the session list running when the index write fails', async () => {
  replayTranscriptRead({ messages: userMessages('healthy', 2), outcome: { byteOffset: 100 } })
  await store.settled()
  index.db.exec('DROP TABLE messages_fts')

  expect(() =>
    replayTranscriptRead({
      mode: 'append',
      previousByteOffset: 100,
      messages: userMessages('broken', 400),
      outcome: { byteOffset: 500 }
    })
  ).not.toThrow()
  expect(store.failures).toBeGreaterThan(0)
  expect(store.takeStale()).toHaveLength(1)
})

it('unregisters cleanly, leaving later reads unindexed', async () => {
  resetTranscriptConsumersForTests()
  replayTranscriptRead({ messages: userMessages('after unregister', 3) })
  await store.settled()

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
})

it('drops a removed source and keeps its cursor gone', async () => {
  replayTranscriptRead({ messages: userMessages('present', 3), outcome: { byteOffset: 100 } })
  await store.settled()
  store.removeFile(SYNTHETIC_TRANSCRIPT)
  await store.purgeOlderThan(null)

  expect(cursor()).toBeUndefined()
  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 })
})

it('publishes the session metadata the read decoded', async () => {
  replayTranscriptRead({
    messages: userMessages('metadata', 1),
    outcome: {
      session: syntheticSession({
        sessionId: 'abc-123',
        title: 'a titled session',
        cwd: '/repo/app',
        branch: 'main',
        messageCount: 1,
        resumeCommand: 'claude --resume abc-123'
      }),
      byteOffset: 42
    }
  })
  await store.settled()

  expect(
    index.db
      .prepare(
        'SELECT session_id, title, cwd, cwd_key, branch, resume_command FROM visible_sessions'
      )
      .get()
  ).toEqual({
    session_id: 'abc-123',
    title: 'a titled session',
    cwd: '/repo/app',
    cwd_key: '/repo/app',
    branch: 'main',
    resume_command: 'claude --resume abc-123'
  })
})

it('keeps a proven file identity when a later read cannot stat it', async () => {
  const withIdentity = syntheticCandidate({ dev: 1, ino: 10 })
  replayTranscriptRead({
    candidate: withIdentity,
    messages: userMessages('first', 2),
    outcome: { byteOffset: 100 }
  })
  await store.settled()

  // A host that cannot prove identity re-reads the same file.
  replayTranscriptRead({
    candidate: syntheticCandidate(),
    mode: 'append',
    previousByteOffset: 100,
    messages: userMessages('second', 2),
    outcome: { byteOffset: 200 }
  })
  await store.settled()
  expect(visibleMessages()).toBe(4)

  // The stored identity survived, so a rename-replace is still detectable.
  replayTranscriptRead({
    candidate: syntheticCandidate({ dev: 1, ino: 99 }),
    mode: 'append',
    previousByteOffset: 200,
    messages: userMessages('replacement', 2),
    outcome: { byteOffset: 300 }
  })
  await store.settled()

  expect(visibleMessages()).toBe(4)
  expect(cursor()).toBe(200)
  expect(store.takeStale()).toHaveLength(1)
})

it('leaves no batch on disk when a rejected read is the last one before shutdown', async () => {
  replayTranscriptRead({ messages: userMessages('indexed', 3), outcome: { byteOffset: 100 } })
  await store.settled()

  // The parser rejects the file, so this read publishes a cursor and tombstones
  // its own staged rows. Nothing writes after it.
  replayTranscriptRead({
    messages: userMessages('rejected', 4),
    outcome: { session: null, byteOffset: 300 }
  })
  await store.settled()

  expect(index.db.prepare('SELECT count(*) AS n FROM search_write_batches').get()).toEqual({ n: 0 })
  expect(index.db.prepare('SELECT count(*) AS n FROM search_pending_deletes').get()).toEqual({
    n: 0
  })
  expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 })
  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
})
