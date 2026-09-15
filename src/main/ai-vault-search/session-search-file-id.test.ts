import { afterEach, beforeEach, expect, it } from 'vitest'
import { SessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexFile,
  syntheticCandidate,
  syntheticSession,
  SYNTHETIC_TRANSCRIPT,
  type SessionSearchIndexFile
} from './session-search-index-test-fixture'
import { sessionSearchReadDecision } from './session-search-read-decision'
import { SessionSearchStore } from './session-search-store'

const LARGE_ID = 25_614_222_884_620_952

let index: SessionSearchIndexFile

let store: SessionSearchStore

let errors: unknown[]

beforeEach(async () => {
  index = await openSessionSearchIndexFile('ss-file-id')
  errors = []
  store = new SessionSearchStore(index.path, (error) => errors.push(error))
})

afterEach(async () => {
  store.close()
  await index.close()
})

it('reads an unsafe INTEGER through the append cursor lookup', () => {
  index.db
    .prepare('INSERT INTO files(path, dev, ino, byte_offset, mtime_ms) VALUES (?, 1, ?, 100, 0)')
    .run(SYNTHETIC_TRANSCRIPT, BigInt(LARGE_ID))
  expect(store.indexedFile(SYNTHETIC_TRANSCRIPT, { dev: 1, ino: LARGE_ID })?.byteOffset).toBe(100)
})

it.each([
  { dev: 1, ino: LARGE_ID },
  { dev: LARGE_ID, ino: 1 },
  { dev: Number.MAX_SAFE_INTEGER, ino: Number.MAX_SAFE_INTEGER },
  { dev: 0, ino: 0 },
  { dev: 1, ino: 2 ** 63 }
])('round-trips numeric stat identity across reopen: %j', (identity) => {
  const candidate = syntheticCandidate(identity)
  const write = store.beginWrite(candidate, 'replace', 0)
  expect(write?.commit({ session: syntheticSession(), byteOffset: 4096, incomplete: false })).toBe(
    true
  )
  store.close()
  store = new SessionSearchStore(index.path, (error) => errors.push(error))

  const row = store.files()[0]
  expect(row?.identity).toEqual(identity)
  const cursor = store.indexedFile(SYNTHETIC_TRANSCRIPT, identity)
  expect(cursor).toEqual({ byteOffset: 4096, mtimeMs: candidate.file.mtimeMs, sizeBytes: 4096 })
  expect(sessionSearchReadDecision({ candidate, row, cursor, cutoffMs: null })).toBe('skip')

  const consumer = new SessionSearchIndexConsumer(store)
  const append = consumer.beginRead({ candidate, mode: 'append', previousByteOffset: 4096 })
  expect(append).not.toBeNull()
  append?.finish({ session: syntheticSession(), byteOffset: 8192, incomplete: false })
  expect(store.indexedFile(SYNTHETIC_TRANSCRIPT, identity)?.byteOffset).toBe(8192)

  for (const replacement of [
    { ...identity, ino: identity.ino + 4096 },
    { ...identity, dev: identity.dev + 4096 }
  ]) {
    const replaced = syntheticCandidate(replacement)
    const replacementCursor = store.indexedFile(SYNTHETIC_TRANSCRIPT, replacement)
    expect(replacementCursor).toBeNull()
    expect(
      sessionSearchReadDecision({
        candidate: replaced,
        row,
        cursor: replacementCursor,
        cutoffMs: null
      })
    ).toBe('whole')
    expect(
      consumer.beginRead({ candidate: replaced, mode: 'append', previousByteOffset: 8192 })
    ).toBeNull()
  }

  expect(errors).toEqual([])
})

it.each([
  { dev: BigInt(LARGE_ID), ino: 1n },
  { dev: 1n, ino: BigInt(LARGE_ID) },
  { dev: null, ino: BigInt(LARGE_ID) },
  { dev: BigInt(LARGE_ID), ino: null },
  { dev: null, ino: null }
])('reads already-written INTEGER identities and incomplete pairs: $dev / $ino', ({ dev, ino }) => {
  index.db
    .prepare('INSERT INTO files(path, dev, ino, byte_offset, mtime_ms) VALUES (?, ?, ?, 100, 0)')
    .run(SYNTHETIC_TRANSCRIPT, dev, ino)

  expect(store.files()[0]?.identity).toEqual(
    dev !== null && ino !== null ? { dev: Number(dev), ino: Number(ino) } : null
  )
  const identity = { dev: Number(dev), ino: Number(ino) }
  expect(store.indexedFile(SYNTHETIC_TRANSCRIPT, identity)?.byteOffset).toBe(100)
  expect(store.indexedFile(SYNTHETIC_TRANSCRIPT, null)?.byteOffset).toBe(100)
  expect(errors).toEqual([])
})
