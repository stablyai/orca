import { afterEach, beforeEach, expect, it } from 'vitest'
import { SessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexFile,
  syntheticCandidate,
  syntheticSession,
  SYNTHETIC_TRANSCRIPT,
  userMessages,
  type SessionSearchIndexFile
} from './session-search-index-test-fixture'
import { SessionSearchStore } from './session-search-store'

// The store is driven directly here. Every guard below is also shadowed by the
// consumer's own check, so a test that goes through the consumer proves nothing
// about which of the two is holding.

let index: SessionSearchIndexFile
let store: SessionSearchStore
let errors: unknown[]

beforeEach(async () => {
  index = await openSessionSearchIndexFile('ss-index-writer')
  errors = []
  store = new SessionSearchStore(index.path, (error) => errors.push(error))
})

afterEach(async () => {
  store.close()
  await index.close()
})

function count(table: string): number {
  return (
    index.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number
    }
  ).n
}

function indexRead(previousByteOffset: number, byteOffset: number, text: string): boolean {
  const write = store.beginWrite(
    syntheticCandidate(),
    previousByteOffset === 0 ? 'replace' : 'append',
    previousByteOffset
  )
  if (!write) {
    return false
  }
  for (const message of userMessages(text, 2)) {
    write.add(message)
  }
  return write.commit({
    session: syntheticSession(),
    byteOffset,
    incomplete: false
  })
}

it('refuses an append whose predecessor offset is not the committed cursor', () => {
  expect(indexRead(0, 100, 'first')).toBe(true)

  expect(store.beginWrite(syntheticCandidate(), 'append', 900)).toBeNull()
  expect(store.beginWrite(syntheticCandidate(), 'append', 99)).toBeNull()
  // The one offset that does continue the committed span is accepted.
  expect(store.beginWrite(syntheticCandidate(), 'append', 100)).not.toBeNull()
})

it('refuses to commit a write whose cursor moved underneath it', () => {
  const stale = store.beginWrite(syntheticCandidate(), 'replace', 0)!
  for (const message of userMessages('stalegeneration', 40)) {
    stale.add(message)
  }
  // A second read of the same path finishes first. Without the parse file lane
  // this is the overlap that would otherwise resurrect the stale rows.
  expect(indexRead(0, 200, 'winninggeneration')).toBe(true)

  expect(
    stale.commit({
      session: syntheticSession(),
      byteOffset: 100,
      incomplete: false
    })
  ).toBe(false)
  expect(store.indexedFile(SYNTHETIC_TRANSCRIPT, null)?.byteOffset).toBe(200)
  expect(count('sessions')).toBe(1)
  expect(count('messages')).toBe(2)
  expect(errors).toEqual([])
})

it('refuses to commit a write whose file was removed mid-read', () => {
  expect(indexRead(0, 100, 'firstgeneration')).toBe(true)
  const write = store.beginWrite(syntheticCandidate(), 'append', 100)!
  for (const message of userMessages('afterremoval', 10)) {
    write.add(message)
  }
  store.removeFile(SYNTHETIC_TRANSCRIPT)

  // Committing here would put a source back that its owner proved was deleted.
  expect(
    write.commit({
      session: syntheticSession(),
      byteOffset: 300,
      incomplete: false
    })
  ).toBe(false)
  expect(store.indexedFile(SYNTHETIC_TRANSCRIPT, null)).toBeNull()
  expect(count('sessions')).toBe(0)
  expect(count('messages')).toBe(0)
  expect(count('files')).toBe(0)
})

it('declines a behind cursor in beginRead before it ever reaches the store', () => {
  const attempted: number[] = []
  const stub = {
    indexedFile: () => ({ byteOffset: 100, mtimeMs: 1, sizeBytes: 1 }),
    beginWrite: (_candidate: unknown, _mode: unknown, previousByteOffset: number) => {
      attempted.push(previousByteOffset)
      return { add: () => undefined, commit: () => true }
    },
    setFileState: () => undefined
  } as unknown as SessionSearchStore
  const consumer = new SessionSearchIndexConsumer(stub)

  expect(
    consumer.beginRead({
      candidate: syntheticCandidate(),
      mode: 'append',
      previousByteOffset: 900
    })
  ).toBeNull()
  // The store was never asked, so the writer's own guard cannot be what refused.
  expect(attempted).toEqual([])
  expect(
    consumer.beginRead({
      candidate: syntheticCandidate(),
      mode: 'append',
      previousByteOffset: 100
    })
  ).not.toBeNull()
  expect(attempted).toEqual([100])
})

it("hands the read's identity accessor to the store", () => {
  const captured: unknown[] = []
  const stub = {
    acceptsCandidate: () => true,
    indexedFile: () => null,
    beginWrite: (
      _candidate: unknown,
      _mode: unknown,
      _previousByteOffset: unknown,
      identity: unknown
    ) => {
      captured.push(identity)
      return { add: () => undefined, commit: () => true }
    },
    markStale: () => undefined
  } as unknown as SessionSearchStore
  const identity = (): null => null

  new SessionSearchIndexConsumer(stub).beginRead({
    candidate: syntheticCandidate(),
    mode: 'replace',
    previousByteOffset: 0,
    identity
  })

  // Dropped here, a chunked read writes rows under a session with no id and no
  // cwd for as long as the read lasts, and for ever if it crashes first.
  expect(captured).toEqual([identity])
})

it('treats half a recorded identity as no identity at all', () => {
  // New partial observations are not stored as identities.
  const partial = {
    ...syntheticCandidate({ dev: 7 }),
    agent: 'claude' as const
  }
  const write = store.beginWrite(partial, 'replace', 0)!
  for (const message of userMessages('halfidentity', 2)) {
    write.add(message)
  }
  write.commit({
    session: syntheticSession(),
    byteOffset: 100,
    incomplete: false
  })
  expect(index.db.prepare('SELECT dev, ino FROM files').get()).toEqual({
    dev: null,
    ino: null
  })
  // Older indexes may still carry a half-pair.
  index.db.exec('UPDATE files SET dev = 7')

  // One matching number is not proof of sameness, and one mismatching number is
  // not proof of replacement. Neither compares, so neither declines.
  expect(store.indexedFile(SYNTHETIC_TRANSCRIPT, { dev: 7, ino: 99 })?.byteOffset).toBe(100)
  expect(store.indexedFile(SYNTHETIC_TRANSCRIPT, { dev: 8, ino: 99 })?.byteOffset).toBe(100)
  expect(store.beginWrite(syntheticCandidate({ dev: 8, ino: 99 }), 'append', 100)).not.toBeNull()
})

it.each([
  [null, { dev: null, ino: null }],
  [
    { dev: 7, ino: 11 },
    { dev: 7, ino: 11 }
  ]
])('never combines partial stats with the previous identity %j', (initial, expected) => {
  const observations = [initial ?? {}, { dev: 9 }, { ino: 13 }, { dev: 17, ino: 19 }]
  for (const [position, identity] of observations.entries()) {
    const write = store.beginWrite(
      syntheticCandidate(identity),
      position ? 'append' : 'replace',
      position * 100
    )!
    expect(
      write.commit({
        session: syntheticSession(),
        byteOffset: (position + 1) * 100,
        incomplete: false
      })
    ).toBe(true)
    expect(index.db.prepare('SELECT dev, ino FROM files').get()).toEqual(
      position === 3 ? { dev: 17, ino: 19 } : expected
    )
  }
})
