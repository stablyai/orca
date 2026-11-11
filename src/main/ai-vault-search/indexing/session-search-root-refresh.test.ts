import '../worker/session-search-worker.test-fixture'
import 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  openSessionSearchIndexerHarness,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'
import { resetSessionParseCacheForTests } from '../../ai-vault/parse-cache/session-parse-cache-store'
import { resetTranscriptConsumersForTests } from '../../ai-vault/transcripts/session-transcript-consumers'

let harness: SessionSearchIndexerHarness
let indexer: SessionSearchIndexer | undefined
beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  harness = await openSessionSearchIndexerHarness('search-root-refresh')
})
afterEach(async () => {
  await indexer?.close()
  indexer = undefined
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  await harness.cleanup()
})

it('does not access a closed store when pending discovery completes', async () => {
  const pending = Promise.withResolvers<typeof harness.roots>()
  const errors = vi.fn()
  const resolver = vi.fn(() => pending.promise)
  indexer = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    resolveRoots: resolver,
    historyDays: null,
    onError: errors
  })
  const start = indexer.start()
  await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(1))
  await indexer.close()
  pending.resolve(harness.roots)
  await start
  expect(errors).not.toHaveBeenCalled()
  expect(indexer.status().filesIndexed).toBe(0)
})

it('retries discovery after failure without silently sweeping stale roots', async () => {
  const errors = vi.fn()
  const resolveRoots = vi
    .fn()
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValue(harness.roots)
  indexer = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    resolveRoots,
    historyDays: null,
    onError: errors
  })
  await indexer.start()
  expect(errors).toHaveBeenCalledTimes(1)
  expect(indexer.status().lastSweepCompletedAt).toBeNull()
  await indexer.reconcile()
  expect(resolveRoots).toHaveBeenCalledTimes(2)
  expect(indexer.status().lastSweepCompletedAt).not.toBeNull()
})
