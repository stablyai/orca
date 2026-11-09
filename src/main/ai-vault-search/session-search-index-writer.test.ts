import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  openSessionSearchIndexFile,
  syntheticCandidate,
  syntheticSession,
  SYNTHETIC_TRANSCRIPT,
  userMessages,
  type SessionSearchIndexFile
} from './session-search-index-test-fixture'
import { SessionSearchStore } from './session-search-store'

// Exercise writer guards directly so consumer checks cannot mask a missing writer check.

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
  expect(store.beginWrite(syntheticCandidate(), 'append', 100)).not.toBeNull()
})

it('refuses to commit a write whose cursor moved underneath it', () => {
  const stale = store.beginWrite(syntheticCandidate(), 'replace', 0)!
  for (const message of userMessages('stalegeneration', 40)) {
    stale.add(message)
  }
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

it('treats half a recorded identity as no identity at all', () => {
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
  index.db.exec('UPDATE files SET dev = 7')

  // A partial legacy identity can prove neither sameness nor replacement.
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
