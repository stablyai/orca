import '../worker/session-search-worker.test-fixture'
import 'node:fs'
import { appendFile, rm, stat, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../../ai-vault/parse-cache/session-parse-cache-store'
import { resetTranscriptConsumersForTests } from '../../ai-vault/transcripts/session-transcript-consumers'
import type SyncDatabase from '../../sqlite/sync-database'
import { SessionSearchIndexer } from './session-search-indexer'
import '../storage/session-search-schema'
import {
  claudeLines,
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

async function nextCycle(): Promise<void> {
  clock.advance(INTERVAL_MS)
  await indexer?.settled()
}

/** Two transcripts untouched for days in one directory, so cycles reuse their indexed stats. */
async function writeQuietTranscripts(): Promise<string> {
  const path = transcriptPath()
  const neighbour = transcriptPath('bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  await writeClaudeTranscript(path, ['original content aaaa'], SESSION_ID)
  await writeClaudeTranscript(
    neighbour,
    ['neighbour content'],
    'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  )
  const quiet = new Date(clock.now() - 2 * 24 * 60 * 60_000)
  for (const file of [path, neighbour, dirname(path)]) {
    await utimes(file, quiet, quiet)
  }
  return path
}

/** Unread transcripts that keep every pass out of read time once each read costs the budget. */
async function writeBacklog(count: number): Promise<void> {
  const dir = join(dirname(harness.claudeProjectDir), 'backlog')
  for (let index = 1; index <= count; index += 1) {
    const id = `${index.toString(16).padStart(8, '0')}-cccc-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(join(dir, `${id}.jsonl`), [`backlog content ${index}`], id)
  }
  clock.costPerNowMs = 5_000
}

it('reflects a rename-replaced transcript that was quiet for days on the next cycle', async () => {
  const path = await writeQuietTranscripts()
  await newIndexer().start()
  // Let a cycle record the quiet directory so later cycles reuse its files' stats.
  await nextCycle()
  expect(sessionsMatching('original')).toEqual([SESSION_ID])
  const original = await stat(path)

  // The replacement keeps a quiet mtime; only its directory shows the change.
  await renameReplaceTranscript(path, ['swapped content bbbbb'], SESSION_ID)
  expect((await stat(path)).size).toBe(original.size)
  await nextCycle()

  expect(sessionsMatching('swapped')).toEqual([SESSION_ID])
  expect(sessionsMatching('original')).toEqual([])
  expect(errors).toEqual([])
})

it('indexes an in-place append to a quiet transcript at the scheduled sweep during a long backlog', async () => {
  const path = await writeQuietTranscripts()
  await newIndexer({ fullSweepEveryCycles: 5 }).start()
  await nextCycle()
  await writeBacklog(20)
  await appendFile(path, `${claudeLines(['appendedneedle'], SESSION_ID, 2).join('\n')}\n`)
  // Linux's coarse mtime clock can tie the append with the backlog; reads go newest first, so date it later.
  const appendedAt = new Date(4_102_444_800_000)
  await utimes(path, appendedAt, appendedAt)

  for (let cycle = 0; cycle < 7; cycle += 1) {
    await nextCycle()
  }

  expect(sessionsMatching('appendedneedle')).toEqual([SESSION_ID])
  expect(errors).toEqual([])
})

it('still reads a quiet transcript that was replaced while its read was deferred', async () => {
  const path = await writeQuietTranscripts()
  await newIndexer().start()
  await nextCycle()
  await writeBacklog(6)
  await renameReplaceTranscript(path, ['swapped content bbbbb'], SESSION_ID)
  // An old, new directory mtime: the first pass sees the change, later passes see a settled directory.
  const changed = new Date(clock.now() - 24 * 60 * 60_000 - 60_000)
  await utimes(dirname(path), changed, changed)

  for (let cycle = 0; cycle < 10; cycle += 1) {
    await nextCycle()
  }

  expect(sessionsMatching('swapped')).toEqual([SESSION_ID])
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
