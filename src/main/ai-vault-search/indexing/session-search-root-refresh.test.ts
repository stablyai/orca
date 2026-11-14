import {
  SessionSearchWorkerClient,
  SessionSearchOperationError
} from '../worker/session-search-worker-client'
import { writeFile } from 'node:fs/promises'
import '../worker/session-search-worker.test-fixture'
import { join } from 'node:path'
import { SessionSearchEngine } from '../query/session-search-engine'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as policy from '../session-search-filesystem'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  openSessionSearchIndexerHarness,
  FakeSessionSearchClock,
  writeClaudeTranscript,
  claudeLines,
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
  vi.restoreAllMocks()
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

it.each(['root lookup', 'retirement wake'])(
  'keeps an explicit full refresh after %s fails on settled history',
  async (failure) => {
    vi.spyOn(policy, 'sessionSearchRequiresPolling').mockResolvedValue(false)
    let unavailable = false
    const errors: unknown[] = []
    const unavailableError =
      failure === 'retirement wake'
        ? new SessionSearchOperationError('unavailable')
        : new Error('unavailable')
    const request = SessionSearchWorkerClient.prototype.request
    vi.spyOn(SessionSearchWorkerClient.prototype, 'request').mockImplementation(async function (
      this: SessionSearchWorkerClient,
      command
    ) {
      if (
        unavailable &&
        failure === 'retirement wake' &&
        command.op === 'catalog' &&
        command.command.kind === 'frontier-wake' &&
        command.command.scope === 'parked-retirement'
      ) {
        unavailable = false
        throw unavailableError
      }
      return request.call(this, command)
    })
    await writeClaudeTranscript(
      join(harness.claudeProjectDir, 'seed.jsonl'),
      ['seed conversation'],
      'seed'
    )
    indexer = new SessionSearchIndexer({
      discoveryPolicy: 'event-led',
      databasePath: harness.databasePath,
      roots: harness.roots,
      resolveRoots: async () => {
        if (unavailable && failure === 'root lookup') {
          throw unavailableError
        }
        return harness.roots
      },
      historyDays: null,
      clock: new FakeSessionSearchClock(),
      onError: (error) => errors.push(error)
    })
    await indexer.start()
    expect(indexer.status().phase).toBe('current')
    await writeFile(
      join(harness.claudeProjectDir, 'missed.jsonl'),
      `${claudeLines(['unnoticed conversation'], 'missed', 0).join('\n')}\n`
    )
    unavailable = true
    await indexer.reconcile({ full: true })
    expect(errors).toContain(unavailableError)
    unavailable = false
    await indexer.reconcile()
    expect(
      harness.read((db) => new SessionSearchEngine(db).search({ query: 'unnoticed' }).hits)
    ).toHaveLength(1)
  }
)
