import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetTranscriptConsumersForTests } from '../../ai-vault/transcripts/session-transcript-consumers'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexFile,
  replayTranscriptRead,
  syntheticCandidate,
  userMessages,
  type SessionSearchIndexFile
} from '../storage/session-search-index-test-fixture'
import { SessionSearchStore } from '../storage/session-search-store'

let index: SessionSearchIndexFile
let store: SessionSearchStore
const messages = userMessages('Searchable conversation', 2)

beforeEach(async () => {
  index = await openSessionSearchIndexFile('ss-list-reparse')
  store = new SessionSearchStore(index.path)
  registerSessionSearchIndexConsumer(store)
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  store.close()
  await index.close()
})

it('keeps the index current when a second fold appends a span it already holds', () => {
  // Pi and OMP can publish the same append when folding one shared transcript.
  replayTranscriptRead({ messages })
  const append = {
    candidate: syntheticCandidate({ sizeBytes: 5000 }),
    mode: 'append' as const,
    previousByteOffset: 4096,
    messages,
    outcome: { byteOffset: 5000 }
  }
  replayTranscriptRead(append)
  replayTranscriptRead(append)
  expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 4 })
  expect(index.db.prepare('SELECT state FROM files').get()).toEqual({ state: 'current' })
})
