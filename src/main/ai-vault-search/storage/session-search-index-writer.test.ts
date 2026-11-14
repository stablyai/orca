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
