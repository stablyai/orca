import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'

let harness: SessionSearchIndexerHarness

let indexer: SessionSearchIndexer | undefined

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  harness = await openSessionSearchIndexerHarness('search-root-refresh')
})

afterEach(async () => {
  indexer?.close()
  indexer = undefined
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  await harness.cleanup()
})

it('refreshes roots on scheduled full sweeps and reuses them on recent cycles', async () => {
  const clock = new FakeSessionSearchClock()
  let roots = harness.roots
  const resolveRoots = vi.fn(async () => roots)
  indexer = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots,
    resolveRoots,
    historyDays: null,
    clock,
    fullSweepEveryCycles: 1
  })
  await indexer.start()
  expect(resolveRoots).toHaveBeenCalledTimes(1)
  const newRoot = join(harness.root, 'late')
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  await writeClaudeTranscript(join(newRoot, 'project', `${id}.jsonl`), ['a late conversation'], id)
  roots = { ...roots, claudeProjectsDir: newRoot }
  clock.advance(20_000)
  await indexer.settled()
  expect(resolveRoots).toHaveBeenCalledTimes(1)
  expect(indexer.status().filesIndexed).toBe(0)
  clock.advance(20_000)
  await indexer.settled()
  expect(resolveRoots).toHaveBeenCalledTimes(2)
  expect(indexer.status().filesIndexed).toBe(1)
  clock.advance(20_000)
  await indexer.settled()
  expect(resolveRoots).toHaveBeenCalledTimes(2)
  expect(indexer.status().filesIndexed).toBe(1)
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
  indexer.close()
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
