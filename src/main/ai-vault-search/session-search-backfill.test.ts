import { mkdir } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import { runSessionSearchBackfill } from './session-search-backfill'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'
import { SessionSearchIndexingStatus } from './session-search-indexing-status'
import type { SessionSearchRootState } from './session-search-root-health'
import { SessionSearchStore } from './session-search-store'

// An aborted sweep saw part of the machine. Letting its observation count
// toward "empty on two consecutive sweeps" means two interrupted passes can
// retire a tree that no completed pass ever looked at.

let harness: SessionSearchIndexerHarness
let store: SessionSearchStore

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  harness = await openSessionSearchIndexerHarness('ss-backfill')
  store = new SessionSearchStore(harness.databasePath)
  registerSessionSearchIndexConsumer(store)
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  store.close()
  await harness.cleanup()
})

it('does not count an aborted sweep toward emptying a root', async () => {
  for (let index = 0; index < 3; index++) {
    const session = `0000000${index}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(
      `${harness.claudeProjectDir}/${session}.jsonl`,
      [`session ${index}`],
      session
    )
  }
  // A second root that exists, lists empty, and held transcripts before.
  const emptied = harness.roots.codexSessionsDir ?? ''
  await mkdir(emptied, { recursive: true })
  const previous: ReadonlyMap<string, SessionSearchRootState> = new Map([
    [emptied, { lastHealthyCount: 3, emptySweeps: 0 }]
  ])

  const controller = new AbortController()
  const status = new SessionSearchIndexingStatus()
  status.indexed = () => controller.abort()

  const sweep = await runSessionSearchBackfill({
    store,
    roots: harness.roots,
    status,
    cutoffMs: null,
    previousRootStates: previous,
    pace: async () => undefined,
    signal: controller.signal
  })

  expect(sweep.completed).toBe(false)
  // The tally is untouched, so a later completed sweep is still the first one.
  expect(sweep.rootStates.get(emptied)).toEqual({ lastHealthyCount: 3, emptySweeps: 0 })
})
