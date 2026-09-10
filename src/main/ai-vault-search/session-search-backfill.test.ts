import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import { runSessionSearchBackfill } from './session-search-backfill'
import { SessionSearchDirectoryListings } from './session-search-directory-listings'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'
import { SessionSearchIndexingStatus } from './session-search-indexing-status'
import { SessionSearchCycleAllowance } from './session-search-reconcile-budget'
import { SessionSearchStore } from './session-search-store'

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

function transcriptPath(index: number): string {
  return join(harness.claudeProjectDir, `0000000${index}-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl`)
}

async function writeTranscripts(count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    const session = `0000000${index}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(transcriptPath(index), [`session ${index}`], session)
  }
}

function sweep(
  overrides: Partial<Parameters<typeof runSessionSearchBackfill>[0]> = {}
): ReturnType<typeof runSessionSearchBackfill> {
  return runSessionSearchBackfill({
    store,
    roots: harness.roots,
    status: new SessionSearchIndexingStatus(),
    cutoffMs: null,
    listings: new SessionSearchDirectoryListings(),
    pace: async () => undefined,
    ...overrides
  })
}

// An aborted sweep saw part of the machine. It has no idea which of the paths
// it holds are still on disk, so publishing its silence would retire whatever
// it had not reached yet.
it('retires nothing and reports nothing when a sweep is aborted', async () => {
  await writeTranscripts(3)
  const first = await sweep()
  expect(first.completed).toBe(true)

  // The three indexed transcripts are gone, and an unread one elsewhere gives
  // the sweep something to abort on before it can reach any verdict.
  await rm(harness.claudeProjectDir, { recursive: true, force: true })
  for (const name of ['ffffffff', 'eeeeeeee']) {
    const session = `${name}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(
      join(harness.roots.claudeProjectsDir ?? '', 'later', `${session}.jsonl`),
      ['a transcript nothing has read'],
      session
    )
  }
  const controller = new AbortController()
  const status = new SessionSearchIndexingStatus()
  status.indexed = () => controller.abort()

  const aborted = await sweep({ status, signal: controller.signal })
  expect(aborted.completed).toBe(false)
  expect(aborted.degradedRoots).toEqual([])
  expect(aborted.watchPaths.size).toBe(0)
  // The rows the sweep never got to are still there.
  expect(store.indexedSources().map((source) => source.path)).toEqual(
    expect.arrayContaining([transcriptPath(0), transcriptPath(1), transcriptPath(2)])
  )
})

// The sweep's reading is budgeted like a cycle's: it plans the whole machine
// and hands back what its allowance had no room for, so a first run cannot own
// the process for as long as the disk is large.
it('reads what its allowance holds and hands back the rest', async () => {
  await writeTranscripts(4)
  const first = await sweep({
    allowance: new SessionSearchCycleAllowance({ files: 2, bytes: 1e9 })
  })

  expect(store.indexedSources()).toHaveLength(2)
  expect(first.deferred).toHaveLength(2)

  // A second sweep skips what the index already covers at its current stat.
  const second = await sweep({
    allowance: new SessionSearchCycleAllowance({ files: 2, bytes: 1e9 })
  })
  expect(store.indexedSources()).toHaveLength(4)
  expect(second.deferred).toEqual([])
})

// The roots a pass listed transcripts under are what the next pass compares
// against, and the only thing carried between them.
it('reports the real roots it listed transcripts under', async () => {
  await writeTranscripts(1)
  const result = await sweep()
  expect([...result.rootsWithFiles]).toEqual([harness.roots.claudeProjectsDir])
})
