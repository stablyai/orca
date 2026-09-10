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
import { runSessionSearchReconcileCycle } from './session-search-reconciler'
import { SessionSearchStore } from './session-search-store'

// A cycle empties the one queue before it reads any of it, so an abort part way
// through has the whole drained set in hand. Anything it did not settle has to
// come back out as `deferred`, or the files it never reached stay missing from
// the index until a sweep happens to rediscover them.

const QUEUED_FILES = 3_000
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

it('hands back everything it drained when a cycle is aborted', async () => {
  for (let index = 0; index < QUEUED_FILES; index++) {
    store.markStale(staleCandidate(index))
  }
  expect(store.pendingFileCount).toBe(QUEUED_FILES)

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
    previousRecent: new Set(),
    listings: new SessionSearchDirectoryListings(),
    signal: controller.signal
  })

  expect(cycle.completed).toBe(false)
  // Nothing settled, so nothing is dropped: the whole drained set comes back
  // for the caller to put on the queue again.
  expect(cycle.deferred).toHaveLength(QUEUED_FILES)
})
