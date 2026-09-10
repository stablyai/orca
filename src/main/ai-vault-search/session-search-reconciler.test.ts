import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { SessionSearchDirectoryListings } from './session-search-directory-listings'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexerHarness,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'
import { SessionSearchIndexingStatus } from './session-search-indexing-status'
import { SessionSearchCycleAllowance } from './session-search-reconcile-budget'
import { runSessionSearchReconcileCycle } from './session-search-reconciler'
import { SessionSearchStore } from './session-search-store'

// The store's re-read set holds ten times what the indexer's queue does, so an
// abort that hands the store's overflow to the smaller queue silently discards
// the difference. Whatever came from the store goes back to the store.

const STALE_FILES = 3_000
const READS_BEFORE_ABORT = 10

let harness: SessionSearchIndexerHarness
let store: SessionSearchStore

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  harness = await openSessionSearchIndexerHarness('ss-reconciler')
  store = new SessionSearchStore(harness.databasePath)
  registerSessionSearchIndexConsumer(store)
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  store.close()
  await harness.cleanup()
})

function staleCandidate(index: number): SessionFileCandidate {
  const at = 1_740_000_000_000 + index
  return {
    agent: 'claude',
    codexHome: null,
    file: {
      path: `${harness.claudeProjectDir}/stale-${index}.jsonl`,
      mtimeMs: at,
      modifiedAt: new Date(at).toISOString(),
      sizeBytes: 128
    }
  }
}

it('hands the store back its own overflow when a cycle is aborted', async () => {
  for (let index = 0; index < STALE_FILES; index++) {
    store.markStale(staleCandidate(index))
  }
  expect(store.pendingFileCount).toBe(STALE_FILES)

  const controller = new AbortController()
  const status = new SessionSearchIndexingStatus()
  let reads = 0
  // None of these paths exist, so every read fails; abort once a few have run.
  status.failed = () => {
    if (++reads >= READS_BEFORE_ABORT) {
      controller.abort()
    }
  }

  const cycle = await runSessionSearchReconcileCycle({
    store,
    roots: harness.roots,
    status,
    recentPerAgent: 12,
    allowance: new SessionSearchCycleAllowance({ files: 10_000, bytes: 1_000_000_000 }),
    pending: [],
    previousRecent: new Set(),
    listings: new SessionSearchDirectoryListings(),
    signal: controller.signal
  })

  expect(cycle.completed).toBe(false)
  // Back where it came from, at its own bound, not truncated into a queue a
  // tenth the size.
  expect(store.pendingFileCount).toBe(STALE_FILES)
  expect(cycle.deferred).toEqual([])
})
