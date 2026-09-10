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
} from './session-search-index-test-fixture'
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

function indexedMessages(): number {
  return (
    index.db.prepare('SELECT count(*) AS n FROM messages').get() as {
      n: number
    }
  ).n
}

function cursor(): number | null | undefined {
  return store.indexedFile(SYNTHETIC_TRANSCRIPT, null)?.byteOffset
}

it('appends onto its own cursor and carries the content hash forward', async () => {
  replayTranscriptRead({
    messages: userMessages('first half', 3),
    outcome: { byteOffset: 100 }
  })
  const first = index.db
    .prepare('SELECT content_hash AS hash, content_hash_count AS count FROM sessions')
    .get() as { hash: string; count: number }

  replayTranscriptRead({
    mode: 'append',
    previousByteOffset: 100,
    messages: userMessages('second half', 2),
    outcome: { byteOffset: 220 }
  })

  expect(indexedMessages()).toBe(5)
  expect(cursor()).toBe(220)
  const second = index.db
    .prepare('SELECT content_hash AS hash, content_hash_count AS count FROM sessions')
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
  expect(cursor()).toBe(100)
  expect(store.takeStale()).toEqual([])

  replayTranscriptRead({
    mode: 'append',
    previousByteOffset: 100,
    messages: userMessages('decoded at last', 2),
    outcome: { byteOffset: 220 }
  })

  expect(indexedMessages()).toBe(2)
  expect(cursor()).toBe(220)
  expect(store.takeStale()).toEqual([])
})

it('declines an append that starts past its own cursor and records the file', async () => {
  replayTranscriptRead({
    messages: userMessages('indexed span', 3),
    outcome: { byteOffset: 100 }
  })

  // The session list read further than this index did, so the appended span
  // continues from bytes the index never saw.
  replayTranscriptRead({
    mode: 'append',
    previousByteOffset: 900,
    messages: userMessages('unseen span', 4),
    outcome: { byteOffset: 1200 }
  })

  expect(indexedMessages()).toBe(3)
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

  replayTranscriptRead({
    candidate: syntheticCandidate({ dev: 1, ino: 77 }),
    mode: 'append',
    previousByteOffset: 100,
    messages: userMessages('replacement file', 2),
    outcome: { byteOffset: 200 }
  })

  expect(indexedMessages()).toBe(2)
  expect(store.takeStale()).toHaveLength(1)
})

it('never advances the cursor for an incomplete read', async () => {
  replayTranscriptRead({
    messages: userMessages('complete span', 3),
    outcome: { byteOffset: 100 }
  })

  replayTranscriptRead({
    mode: 'append',
    previousByteOffset: 100,
    messages: userMessages('partial span', 5),
    outcome: { byteOffset: 400, incomplete: true }
  })

  expect(indexedMessages()).toBe(3)
  expect(cursor()).toBe(100)
  expect(
    (
      index.db.prepare('SELECT count(*) AS n FROM messages').get() as {
        n: number
      }
    ).n
  ).toBe(3)
  expect(store.takeStale()).toHaveLength(1)
})

it('indexes nothing at all from a read that was incomplete from the start', async () => {
  replayTranscriptRead({
    messages: userMessages('unreachable', 4),
    outcome: { byteOffset: 0, incomplete: true }
  })

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
    n: 0
  })
  expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({
    n: 0
  })
  expect(cursor()).toBeUndefined()
})

it('drops a file whose parser returned no session', async () => {
  replayTranscriptRead({
    messages: userMessages('was indexed', 3),
    outcome: { byteOffset: 100 }
  })

  replayTranscriptRead({
    messages: userMessages('now rejected', 2),
    outcome: { session: null, byteOffset: 300 }
  })

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
    n: 0
  })
  expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({
    n: 0
  })
  // The file is still read through, so a later scan does not re-read it.
  expect(cursor()).toBe(300)
})

it('writes nothing for a source whose parser cannot reach the channel', async () => {
  // An OpenCode SQLite candidate decodes in a worker, so every read of it is
  // incomplete, and no re-read would help.
  const candidate = {
    ...syntheticCandidate({ path: '/opencode/opencode.db#session-1' }),
    agent: 'opencode' as const
  }
  replayTranscriptRead({
    candidate,
    messages: [],
    outcome: { byteOffset: 0, incomplete: true }
  })

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
    n: 0
  })
  expect(store.takeStale()).toEqual([])
})

it('ignores a candidate older than the retention cutoff', async () => {
  store.setRetentionCutoffMs(Date.now())
  replayTranscriptRead({ messages: userMessages('too old', 3) })

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
    n: 0
  })
  expect(store.takeStale()).toEqual([])
})

it('stops writing while the store refuses writes, but remembers what it skipped', async () => {
  store.setAcceptingWrites(false)
  replayTranscriptRead({ messages: userMessages('paused', 3) })

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
    n: 0
  })
  expect(errors).toEqual([])
  // A pause is exactly the window in which every read is declined. Forgetting
  // them would leave the whole paused span unindexed with nothing to replay it.
  expect(store.takeStale().map((candidate) => candidate.file.path)).toEqual([SYNTHETIC_TRANSCRIPT])
})

it('keeps the paused re-read set when the retention window is reconfigured', async () => {
  store.setAcceptingWrites(false)
  replayTranscriptRead({ messages: userMessages('paused', 2) })
  expect(store.pendingFileCount).toBe(1)

  // The set records what still has to be read, not what is worth keeping. A
  // window that now excludes this file is enforced where the re-read is
  // dispatched, so nothing is written and the file leaves the set there.
  store.setRetentionCutoffMs(Date.now())
  expect(store.pendingFileCount).toBe(1)

  store.setAcceptingWrites(true)
  expect(store.takeStale()).toHaveLength(1)
  replayTranscriptRead({ messages: userMessages('outside the window now', 2) })
  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
    n: 0
  })
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

  // A drop says the queue is missing something. A completed full sweep
  // re-enumerates every root, so it is what makes that stop being true; the
  // count is a report on the current queue, not a lifetime tally.
  store.forgetDroppedPending()
  expect(store.droppedPendingFileCount).toBe(0)
})

it('keeps the session list running when the index write fails', async () => {
  replayTranscriptRead({
    messages: userMessages('healthy', 2),
    outcome: { byteOffset: 100 }
  })
  index.db.exec('DROP TABLE messages_fts')

  expect(() =>
    replayTranscriptRead({
      mode: 'append',
      previousByteOffset: 100,
      messages: userMessages('broken', 400),
      outcome: { byteOffset: 500 }
    })
  ).not.toThrow()
  expect(errors.length).toBeGreaterThan(0)
  expect(store.takeStale()).toHaveLength(1)
})

it('unregisters cleanly, leaving later reads unindexed', async () => {
  resetTranscriptConsumersForTests()
  replayTranscriptRead({ messages: userMessages('after unregister', 3) })

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
    n: 0
  })
})

it('drops a removed source and keeps its cursor gone', async () => {
  replayTranscriptRead({
    messages: userMessages('present', 3),
    outcome: { byteOffset: 100 }
  })
  store.removeFile(SYNTHETIC_TRANSCRIPT)

  expect(cursor()).toBeUndefined()
  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
    n: 0
  })
  expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({
    n: 0
  })
})

it('writes the session metadata the read decoded', async () => {
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

  expect(
    index.db
      .prepare('SELECT session_id, title, cwd, cwd_key, branch, resume_command FROM sessions')
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

  // A host that cannot prove identity re-reads the same file.
  replayTranscriptRead({
    candidate: syntheticCandidate(),
    mode: 'append',
    previousByteOffset: 100,
    messages: userMessages('second', 2),
    outcome: { byteOffset: 200 }
  })
  expect(indexedMessages()).toBe(4)

  // The stored identity survived, so a rename-replace is still detectable.
  replayTranscriptRead({
    candidate: syntheticCandidate({ dev: 1, ino: 99 }),
    mode: 'append',
    previousByteOffset: 200,
    messages: userMessages('replacement', 2),
    outcome: { byteOffset: 300 }
  })

  expect(indexedMessages()).toBe(4)
  expect(cursor()).toBe(200)
  expect(store.takeStale()).toHaveLength(1)
})
