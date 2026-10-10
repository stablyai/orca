import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { TranscriptMessageChannel } from '../ai-vault/session-transcript-channel'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { SessionSearchIndexWriter } from './session-search-index-writer'
import {
  openSessionSearchIndexFile,
  syntheticCandidate,
  syntheticSession,
  type SessionSearchIndexFile
} from './session-search-index-test-fixture'
import { SessionSearchStore } from './session-search-store'

let index: SessionSearchIndexFile
let store: SessionSearchStore
let writer: SessionSearchIndexWriter
let unregister: () => void
const message = { role: 'user' as const, text: 'needle', timestamp: null }
const outcome = { session: syntheticSession(), byteOffset: 100, incomplete: false }

function trackedPaths(): number {
  return writer['activeWrites'].size
}

function openRead(named = true): TranscriptMessageChannel {
  const channel = new TranscriptMessageChannel()
  channel.beginRead({
    candidate: syntheticCandidate(),
    mode: 'replace',
    previousByteOffset: 0,
    identity: named ? () => syntheticSession() : undefined
  })
  return channel
}

function failInsert(): void {
  const prepare = index.db.prepare.bind(index.db)
  vi.spyOn(index.db, 'prepare').mockImplementation((sql) => {
    if (sql.startsWith('INSERT INTO sessions')) {
      throw new Error('Synthetic insert failure')
    }
    return prepare(sql)
  })
}

beforeEach(async () => {
  index = await openSessionSearchIndexFile('ss-write-lifetime')
  store = new SessionSearchStore(index.path)
  writer = new SessionSearchIndexWriter(index.db, 1)
  vi.spyOn(store, 'beginWrite').mockImplementation((...args) => writer.beginWrite(...args))
  unregister = registerSessionSearchIndexConsumer(store)
})

afterEach(async () => {
  unregister()
  writer.close()
  vi.restoreAllMocks()
  store.close()
  await index.close()
})

it('retains no path metadata for repeated deletions without active writes', () => {
  for (let index = 0; index < 1000; index++) {
    writer.removeFile(join('synthetic', `retired-${index}.jsonl`))
  }
  expect(trackedPaths()).toBe(0)
})

it('keeps the fence across intermediate chunks and releases it after final commit', () => {
  const write = writer.beginWrite(syntheticCandidate(), 'replace', 0, () => syntheticSession())!
  write.add(message)
  expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toMatchObject({ n: 1 })
  expect(trackedPaths()).toBe(1)
  expect(write.commit(outcome)).toBe(true)
  expect(trackedPaths()).toBe(0)
  write.discard()
  write.discard()
  expect(write.commit(outcome)).toBe(false)
  expect(trackedPaths()).toBe(0)
})

it('keeps concurrent reads fenced until each ends', () => {
  const first = writer.beginWrite(syntheticCandidate(), 'replace', 0)!
  const second = writer.beginWrite(syntheticCandidate(), 'replace', 0)!
  first.discard()
  first.discard()
  expect(trackedPaths()).toBe(1)
  writer.removeFile(syntheticCandidate().file.path)
  second.add(message)
  expect(second.commit(outcome)).toBe(false)
  expect(trackedPaths()).toBe(0)
  expect(index.db.prepare('SELECT count(*) AS n FROM files').get()).toMatchObject({ n: 0 })
})

it('preserves the new generation when an older removed read finishes', () => {
  const candidate = syntheticCandidate()
  const old = writer.beginWrite(candidate, 'replace', 0)!
  writer.removeFile(candidate.file.path)
  expect(trackedPaths()).toBe(0)
  const current = writer.beginWrite(candidate, 'replace', 0)!
  old.discard()
  expect(trackedPaths()).toBe(1)
  writer.removeFile(candidate.file.path)
  current.add(message)
  expect(current.commit(outcome)).toBe(false)
  expect(trackedPaths()).toBe(0)
  expect(index.db.prepare('SELECT count(*) AS n FROM files').get()).toMatchObject({ n: 0 })
})

it('permits a fresh read after removal while still refusing an older commit', () => {
  const candidate = syntheticCandidate()
  const old = writer.beginWrite(candidate, 'replace', 0)!
  writer.removeFile(candidate.file.path)
  const current = writer.beginWrite(candidate, 'replace', 0)!
  old.add(message)
  expect(old.commit(outcome)).toBe(false)
  expect(trackedPaths()).toBe(1)
  current.add(message)
  expect(current.commit(outcome)).toBe(true)
  expect(trackedPaths()).toBe(0)
})

it('releases a write when its final transaction throws', () => {
  const write = writer.beginWrite(syntheticCandidate(), 'replace', 0)!
  write.add(message)
  failInsert()
  expect(() => write.commit(outcome)).toThrow('Synthetic insert failure')
  expect(trackedPaths()).toBe(0)
  write.discard()
  expect(trackedPaths()).toBe(0)
})

it('discards an incomplete consumer read without publishing its buffer', () => {
  const channel = openRead(false)
  channel.push(message)
  expect(trackedPaths()).toBe(1)
  channel.finishRead({ session: null, byteOffset: 0, incomplete: true })
  expect(trackedPaths()).toBe(0)
  expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toMatchObject({ n: 0 })
  expect(index.db.prepare('SELECT state FROM files').get()).toMatchObject({ state: 'failed' })
})

it.each([false, true])(
  'keeps removed content absent when a consumer finishes, chunked: %s',
  (chunked) => {
    const channel = openRead(chunked)
    channel.push(message)
    writer.removeFile(syntheticCandidate().file.path)
    expect(index.db.prepare('SELECT count(*) AS n FROM files').get()).toMatchObject({ n: 0 })
    channel.finishRead(outcome)
    expect(trackedPaths()).toBe(0)
    expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toMatchObject({ n: 0 })
    expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toMatchObject({ n: 0 })
    // Existing retry bookkeeping may recreate a failed file row, never its searchable content.
    expect(index.db.prepare('SELECT state FROM files').get()).toMatchObject({ state: 'failed' })
  }
)

it.each([false, true])(
  'releases a failed consumer even when the reporter throws: %s',
  (reporterThrows) => {
    vi.spyOn(store, 'reportWriteFailure').mockImplementation(() => {
      if (reporterThrows) {
        throw new Error('Synthetic reporter failure')
      }
    })
    const channel = openRead()
    failInsert()
    expect(() => channel.push(message)).not.toThrow()
    expect(channel.active).toBe(!reporterThrows)
    expect(trackedPaths()).toBe(0)
    channel.finishRead(outcome)
    expect(trackedPaths()).toBe(0)
  }
)

it('discards after a finish failure even if the error reporter throws', () => {
  const channel = new TranscriptMessageChannel()
  channel.beginRead({ candidate: syntheticCandidate(), mode: 'replace', previousByteOffset: 0 })
  channel.push(message)
  vi.spyOn(store, 'reportWriteFailure').mockImplementation(() => {
    throw new Error('Synthetic reporter failure')
  })
  failInsert()
  expect(() => channel.finishRead(outcome)).not.toThrow()
  expect(channel.active).toBe(false)
  expect(trackedPaths()).toBe(0)
})

it('invalidates every write on close and refuses later writes', () => {
  const write = writer.beginWrite(syntheticCandidate(), 'replace', 0)!
  write.add(message)
  writer.close()
  writer.close()
  expect(trackedPaths()).toBe(0)
  expect(() => write.add(message)).not.toThrow()
  expect(write.commit(outcome)).toBe(false)
  expect(writer.beginWrite(syntheticCandidate(), 'replace', 0)).toBeNull()
  expect(index.db.prepare('SELECT count(*) AS n FROM files').get()).toMatchObject({ n: 0 })
})

it('closes the owned writer before closing the store database', () => {
  vi.mocked(store.beginWrite).mockRestore()
  const write = store.beginWrite(syntheticCandidate(), 'replace', 0)!
  write.add(message)
  store.close()
  expect(() => write.add(message)).not.toThrow()
  expect(write.commit(outcome)).toBe(false)
})
