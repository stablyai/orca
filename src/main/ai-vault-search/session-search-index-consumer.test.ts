import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetTranscriptConsumersForTests } from '../ai-vault/transcripts/session-transcript-consumers'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexFile,
  replayTranscriptRead,
  SYNTHETIC_TRANSCRIPT,
  userMessages,
  type SessionSearchIndexFile
} from './session-search-index-test-fixture'
import { SessionSearchStore } from './session-search-store'

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

function owed(): { state: string; fail_count: number } | undefined {
  return index.db
    .prepare('SELECT state, fail_count FROM files WHERE path = ?')
    .get(SYNTHETIC_TRANSCRIPT) as { state: string; fail_count: number } | undefined
}

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
  expect(owed()?.state).not.toBe('current')
})
