import { afterEach, beforeEach, expect, it, vi } from 'vitest'

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

it('closes the owned writer before closing the store database', () => {
  vi.mocked(store.beginWrite).mockRestore()
  const write = store.beginWrite(syntheticCandidate(), 'replace', 0)!
  write.add(message)
  store.close()
  expect(() => write.add(message)).not.toThrow()
  expect(write.commit(outcome)).toBe(false)
})
