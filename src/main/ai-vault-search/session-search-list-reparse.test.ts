import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexFile,
  replayTranscriptRead,
  syntheticCandidate,
  userMessages,
  type SessionSearchIndexFile
} from './session-search-index-test-fixture'
import { SessionSearchStore } from './session-search-store'

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

function sessionRow(): unknown {
  return index.db.prepare('SELECT id FROM sessions').get()
}

it('keeps current search rows when a cold history list rereads the same transcript', () => {
  replayTranscriptRead({ messages })
  const before = sessionRow()
  replayTranscriptRead({ messages })
  expect(sessionRow()).toEqual(before)
  expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 2 })
})

it('still replaces a changed transcript', () => {
  const candidate = syntheticCandidate()
  replayTranscriptRead({ candidate, messages })
  const before = sessionRow()
  replayTranscriptRead({
    candidate: syntheticCandidate({ mtimeMs: candidate.file.mtimeMs + 1 }),
    messages
  })
  expect(sessionRow()).not.toEqual(before)
})

it('still replaces a transcript whose size changed without a timestamp change', () => {
  replayTranscriptRead({ messages })
  const before = sessionRow()
  replayTranscriptRead({ candidate: syntheticCandidate({ sizeBytes: 5000 }), messages })
  expect(sessionRow()).not.toEqual(before)
})

it('refreshes metadata supplied by a sidecar despite an unchanged transcript', () => {
  replayTranscriptRead({ messages })
  const before = sessionRow()
  replayTranscriptRead({
    candidate: syntheticCandidate({
      sidecar: { path: 'metadata.json', mtimeMs: 1, sizeBytes: 10 }
    }),
    messages
  })
  expect(sessionRow()).not.toEqual(before)
})

it('rereads when the transcript size is unknown', () => {
  replayTranscriptRead({ messages })
  const before = sessionRow()
  replayTranscriptRead({ candidate: syntheticCandidate({ sizeBytes: undefined }), messages })
  expect(sessionRow()).not.toEqual(before)
})

it('still replaces a different file with identical size and timestamp', () => {
  replayTranscriptRead({ candidate: syntheticCandidate({ dev: 1, ino: 10 }), messages })
  const before = sessionRow()
  replayTranscriptRead({ candidate: syntheticCandidate({ dev: 1, ino: 11 }), messages })
  expect(sessionRow()).not.toEqual(before)
})

it('rereads a row indexed without a file identity once the stat supplies one', () => {
  replayTranscriptRead({ messages })
  const before = sessionRow()
  const identified = syntheticCandidate({ dev: 1, ino: 10 })
  replayTranscriptRead({ candidate: identified, messages })
  expect(sessionRow()).not.toEqual(before)
  const repaired = sessionRow()
  replayTranscriptRead({ candidate: identified, messages })
  expect(sessionRow()).toEqual(repaired)
})

it.each(['due', 'failed'] as const)('repairs an unchanged transcript marked %s', (state) => {
  replayTranscriptRead({ messages })
  const before = sessionRow()
  store.setFileState(syntheticCandidate().file.path, state)
  replayTranscriptRead({ messages })
  expect(sessionRow()).not.toEqual(before)
  expect(index.db.prepare('SELECT state FROM files').get()).toEqual({ state: 'current' })
})

it('repairs a partial index even when the stat matches', () => {
  replayTranscriptRead({ messages })
  const before = sessionRow()
  index.db.exec('UPDATE files SET byte_offset = -1')
  replayTranscriptRead({ messages })
  expect(sessionRow()).not.toEqual(before)
})

it('still indexes new appended messages', () => {
  replayTranscriptRead({ messages })
  replayTranscriptRead({
    candidate: syntheticCandidate({ sizeBytes: 5000 }),
    mode: 'append',
    previousByteOffset: 4096,
    messages,
    outcome: { byteOffset: 5000 }
  })
  expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 4 })
})
