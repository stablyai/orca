import '../worker/session-search-worker.test-fixture'
import { join } from 'node:path'
import { SessionSearchEngine } from '../query/session-search-engine'
import { afterEach, beforeEach, expect, it } from 'vitest'
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
    discoveryPolicy: 'event-led',
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

it('retries discovery after failure without silently sweeping stale roots', async () => {
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
    discoveryPolicy: 'event-led',
    databasePath: harness.databasePath,
    roots: harness.roots,
    resolveRoots,
    historyDays: null,
    onError: () => undefined
  })
  await indexer.start()
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
