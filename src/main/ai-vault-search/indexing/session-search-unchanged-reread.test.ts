import { stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetTranscriptConsumersForTests } from '../../ai-vault/transcripts/session-transcript-consumers'
import { SessionSearchDirectoryListings } from '../discovery/session-search-directory-listings'
import { SessionSearchStore } from '../storage/session-search-store'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'
import { runSessionSearchPass } from './session-search-pass'

let harness: SessionSearchIndexerHarness
let store: SessionSearchStore

beforeEach(async () => {
  harness = await openSessionSearchIndexerHarness('ss-unchanged-reread')
  store = new SessionSearchStore(harness.databasePath)
  registerSessionSearchIndexConsumer(store)
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  store.close()
  await harness.cleanup()
})

function pass(): Promise<unknown> {
  return runSessionSearchPass({
    store,
    roots: harness.roots,
    full: true,
    recentPerAgent: Number.POSITIVE_INFINITY,
    listings: new SessionSearchDirectoryListings()
  })
}

function indexed(): { session: number; lastMessage: number; messages: number } {
  return harness.read((db) => {
    const row = db
      .prepare(
        `SELECT f.session_row_id AS session, max(m.id) AS lastMessage, count(m.id) AS messages
         FROM files f JOIN messages m ON m.session_row_id = f.session_row_id`
      )
      .get()
    return {
      session: Number(row?.session),
      lastMessage: Number(row?.lastMessage),
      messages: Number(row?.messages)
    }
  })
}

it('keeps the indexed rows when a transcript is reread with only its mtime changed', async () => {
  const transcript = join(harness.claudeProjectDir, 'touched.jsonl')
  await writeClaudeTranscript(transcript, ['first question', 'second question'], 'touched')
  await pass()
  const before = indexed()
  expect(before.messages).toBe(4)

  // Something outside Orca bumps the mtime without changing a byte; the reader must reread it.
  const { mtimeMs } = await stat(transcript)
  const later = new Date(mtimeMs + 3_600_000)
  await utimes(transcript, later, later)
  await pass()

  // Rewriting would retire the session row and insert every message again under new ids.
  expect(indexed()).toEqual(before)
  expect(store.files()[0]?.mtimeMs).toBe(later.getTime())
})
