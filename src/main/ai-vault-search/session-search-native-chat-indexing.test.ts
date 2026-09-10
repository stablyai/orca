import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'

// Reviewer F4, and the plan's fourth open decision: a conversation held in
// Orca's own chat is the same file in the same place as one held in the
// terminal, so it must be searchable through the same path with no panel
// mounted, no scanner service running, and nobody calling refresh. Everything
// below is the library and the filesystem.

const INTERVAL_MS = 20_000
const SESSION_ID = 'cccccccc-dddd-4eee-8fff-000000000000'
const CWD = '/repo/orca'

let harness: SessionSearchIndexerHarness
let clock: FakeSessionSearchClock
let indexer: SessionSearchIndexer

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  clock = new FakeSessionSearchClock()
  harness = await openSessionSearchIndexerHarness('ss-native-chat')
})

afterEach(async () => {
  indexer.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness.cleanup()
})

/** The rows Orca's native chat writes: uuid, block content, cwd on the first turn. */
function nativeChatTurn(uuid: string, role: 'user' | 'assistant', text: string): string {
  const timestamp = new Date(1_740_000_000_000 + Number(uuid.slice(-2)) * 60_000).toISOString()
  return JSON.stringify({
    type: role,
    uuid,
    sessionId: SESSION_ID,
    timestamp,
    cwd: CWD,
    gitBranch: 'main',
    message: {
      role,
      ...(role === 'assistant' ? { model: 'claude-fable-5' } : {}),
      content: [{ type: 'text', text }]
    }
  })
}

function messageTexts(term: string): { role: string; session: string }[] {
  return harness.read(
    (db: SyncDatabase) =>
      db
        .prepare(
          `SELECT m.role AS role, s.session_id AS session FROM messages_fts
           JOIN messages m ON m.id = messages_fts.rowid
           JOIN sessions s ON s.id = m.session_row_id
           WHERE messages_fts MATCH ? ORDER BY m.id`
        )
        .all(term) as { role: string; session: string }[]
  )
}

it('indexes a native-chat conversation and its later turns with no panel and no service', async () => {
  const path = join(harness.claudeProjectDir, `${SESSION_ID}.jsonl`)
  await mkdir(harness.claudeProjectDir, { recursive: true })
  await writeFile(
    path,
    `${[
      nativeChatTurn('turn-01', 'user', 'why does the relay drop the lease at 105 seconds'),
      nativeChatTurn('turn-02', 'assistant', 'that is the client silence watchdog, not a cliff')
    ].join('\n')}\n`
  )

  indexer = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock,
    reconcileIntervalMs: INTERVAL_MS,
    pace: async () => undefined
  })
  await indexer.start()

  expect(messageTexts('watchdog')).toEqual([{ role: 'assistant', session: SESSION_ID }])
  expect(harness.read((db: SyncDatabase) => db.prepare('SELECT cwd FROM sessions').get())).toEqual({
    cwd: CWD
  })

  // The conversation continues in the panel; nothing tells the index about it.
  await appendFile(
    path,
    `${[
      nativeChatTurn('turn-03', 'user', 'and the fleetwide 4408 bursts'),
      nativeChatTurn('turn-04', 'assistant', 'those are desktop lease rotations, cohort waves')
    ].join('\n')}\n`
  )
  clock.advance(INTERVAL_MS)
  await indexer.settled()

  expect(messageTexts('cohort')).toEqual([{ role: 'assistant', session: SESSION_ID }])
  expect(messageTexts('4408')).toEqual([{ role: 'user', session: SESSION_ID }])
  expect(indexer.status().phase).toBe('current')
})
