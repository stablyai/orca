import '../worker/session-search-worker.test-fixture'
import { join } from 'node:path'
import { SessionSearchEngine } from '../query/session-search-engine'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  openSessionSearchIndexerHarness,
  FakeSessionSearchClock,
  writeClaudeTranscript,
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

it('finds a changed session location on maintenance after ordinary cycles reuse the old location', async () => {
  const clock = new FakeSessionSearchClock()
  let roots = harness.roots
  const resolveRoots = async () => roots
  indexer = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots,
    resolveRoots,
    historyDays: null,
    clock,
    fullSweepEveryCycles: 2
  })
  await indexer.start()
  const newRoot = join(harness.root, 'late')
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  await writeClaudeTranscript(join(newRoot, 'project', `${id}.jsonl`), ['a late conversation'], id)
  roots = { ...roots, claudeProjectsDir: newRoot }
  clock.advance(20_000)
  await indexer.settled()
  expect(indexer.status().filesIndexed).toBe(0)
  clock.advance(20_000)
  await indexer.settled()
  expect(
    harness.read((db) => new SessionSearchEngine(db).search({ query: 'a late conversation' }).hits)
  ).toHaveLength(1)
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
  let unavailable = true
  const path = join(harness.claudeProjectDir, 'recovery.jsonl')
  await writeClaudeTranscript(path, ['recovered conversation'], 'recovery')
  const resolveRoots = async () => {
    if (unavailable) {
      throw new Error('unavailable')
    }
    return harness.roots
  }
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
  expect(indexer.status().filesIndexed).toBe(0)
  unavailable = false
  await indexer.reconcile()
  expect(
    harness.read((db) =>
      db
        .prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'recovered'")
        .get()
    )
  ).toEqual({ n: 2 })
})
