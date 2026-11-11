import '../worker/session-search-worker.test-fixture'
import { notifySessionSearchRootChanges } from '../session-search-watcher.test-fixture'
import 'node:fs'
import { rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../../ai-vault/parse-cache/session-parse-cache-store'
import { resetTranscriptConsumersForTests } from '../../ai-vault/transcripts/session-transcript-consumers'
import type SyncDatabase from '../../sqlite/sync-database'
import { SessionSearchIndexer } from './session-search-indexer'
import '../storage/session-search-schema'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  renameReplaceTranscript,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'

const INTERVAL_MS = 20_000
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

let harness: SessionSearchIndexerHarness
let clock: FakeSessionSearchClock
let indexer: SessionSearchIndexer | null
let errors: unknown[]

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  errors = []
  clock = new FakeSessionSearchClock()
  harness = await openSessionSearchIndexerHarness('ss-indexer')
  indexer = null
})

afterEach(async () => {
  await indexer?.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness.cleanup()
})

function newIndexer(
  overrides: Partial<ConstructorParameters<typeof SessionSearchIndexer>[0]> = {}
) {
  indexer = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock,
    reconcileIntervalMs: INTERVAL_MS,
    onError: (error) => errors.push(error),
    ...overrides
  })
  return indexer
}

function sessionsMatching(term: string): string[] {
  return harness.read((db: SyncDatabase) =>
    (
      db
        .prepare(
          `SELECT DISTINCT s.session_id AS id FROM messages_fts
           JOIN messages m ON m.id = messages_fts.rowid
           JOIN sessions s ON s.id = m.session_row_id
           WHERE messages_fts MATCH ? ORDER BY s.session_id`
        )
        .all(term) as { id: string }[]
    ).map((row) => row.id)
  )
}

function transcriptPath(name = SESSION_ID): string {
  return join(harness.claudeProjectDir, `${name}.jsonl`)
}

function rowFor(path: string) {
  return harness.read((db: SyncDatabase) =>
    db.prepare('SELECT state, fail_count AS failCount FROM files WHERE path = ?').get(path)
  )
}

function readsPerPass(files: number): { passDeadlineMs: number; discoveryDeadlineMs: number } {
  clock.costPerNowMs = 1_000
  return { passDeadlineMs: files * 1_000, discoveryDeadlineMs: Infinity }
}

async function nextCycle(): Promise<void> {
  notifySessionSearchRootChanges()
  clock.advance(INTERVAL_MS)
  await indexer?.settled()
}

it('reflects a rename-replaced transcript within one reconcile interval', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['original content aaaa'], SESSION_ID)
  await newIndexer().start()
  expect(sessionsMatching('original')).toEqual([SESSION_ID])
  const original = await stat(path)

  await renameReplaceTranscript(path, ['swapped content bbbbb'], SESSION_ID)
  expect((await stat(path)).size).toBe(original.size)
  await nextCycle()

  expect(sessionsMatching('swapped')).toEqual([SESSION_ID])
  expect(sessionsMatching('original')).toEqual([])
  expect(errors).toEqual([])
})

it('keeps a root that is gone at the first sweep after a restart', async () => {
  await writeClaudeTranscript(transcriptPath(), ['a session on a removable volume'], SESSION_ID)
  await newIndexer().start()
  await indexer?.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()

  await rm(harness.roots.claudeProjectsDir ?? '', { recursive: true, force: true })
  await newIndexer().start()

  const status = indexer?.status()
  expect(status?.phase).toBe('degraded')
  expect(status?.degradedRoots.map((root) => root.root)).toContain(harness.roots.claudeProjectsDir)
  expect(sessionsMatching('removable')).toEqual([SESSION_ID])

  await writeClaudeTranscript(transcriptPath(), ['a session on a removable volume'], SESSION_ID)
  await indexer?.reconcile({ full: true })
  expect(indexer?.status()).toMatchObject({ phase: 'current', degradedRoots: [] })
})

it('retains a deferred recent file after it leaves the top-N window', async () => {
  await newIndexer({ ...readsPerPass(1), recentPerAgent: 2 }).start()
  const ids = [
    '11111111-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    '22222222-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    '33333333-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  ]
  const paths = ids.map((id) => transcriptPath(id))
  await writeClaudeTranscript(paths[0], ['deferredreviewneedle'], ids[0])
  await writeClaudeTranscript(paths[1], ['firstreviewneedle'], ids[1])
  const time = Date.UTC(2099, 0, 1)
  await utimes(paths[0], new Date(time), new Date(time))
  await utimes(paths[1], new Date(time + 1000), new Date(time + 1000))
  await nextCycle()
  expect(rowFor(paths[0])).toBeUndefined()
  expect(indexer?.status().filesDue).toBe(1)
  await writeClaudeTranscript(paths[2], ['newestreviewneedle'], ids[2])
  await utimes(paths[2], new Date(time + 2000), new Date(time + 2000))
  await nextCycle()
  await nextCycle()
  expect(sessionsMatching('deferredreviewneedle')).toEqual([ids[0]])
})
