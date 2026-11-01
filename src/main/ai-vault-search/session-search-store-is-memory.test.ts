import { chmod, rm, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'

const INTERVAL_MS = 20_000
const CAN_DENY_READ = process.platform !== 'win32' && process.getuid?.() !== 0
const FIRST = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const SECOND = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const THIRD = 'cccccccc-dddd-4eee-8fff-000000000000'

let harness: SessionSearchIndexerHarness
let clock: FakeSessionSearchClock
let indexer: SessionSearchIndexer | null
let errors: unknown[]

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  errors = []
  clock = new FakeSessionSearchClock()
  harness = await openSessionSearchIndexerHarness('ss-memory')
  indexer = null
})

afterEach(async () => {
  indexer?.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness.cleanup()
})

function newIndexer(
  overrides: Partial<ConstructorParameters<typeof SessionSearchIndexer>[0]> = {}
): SessionSearchIndexer {
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

function transcriptPath(name: string): string {
  return join(harness.claudeProjectDir, `${name}.jsonl`)
}

async function nextCycle(): Promise<void> {
  clock.advance(INTERVAL_MS)
  await indexer?.settled()
}

function fileTable(): unknown[] {
  return harness.read((db: SyncDatabase) =>
    db
      .prepare(
        `SELECT path, dev, ino, byte_offset, mtime_ms, size_bytes, session_row_id,
                state, fail_count, failed_mtime_ms
         FROM files ORDER BY path`
      )
      .all()
  )
}

it('S1: reports exactly what a hand-written query over the rows reports', async () => {
  await writeClaudeTranscript(transcriptPath(FIRST), ['one'], FIRST)
  await writeClaudeTranscript(transcriptPath(SECOND), ['two'], SECOND)
  await newIndexer().start()

  const bySql = (): Record<string, number> =>
    Object.fromEntries(
      (
        harness.read((db: SyncDatabase) =>
          db.prepare('SELECT state, count(*) AS n FROM files GROUP BY state').all()
        ) as { state: string; n: number }[]
      ).map((row) => [row.state, Number(row.n)])
    )

  const reported = indexer?.status()
  const counted = bySql()
  expect(reported?.filesIndexed).toBe(counted.current ?? 0)
  expect(reported?.filesDue).toBe(counted.due ?? 0)
  expect(reported?.filesFailed).toBe(counted.failed ?? 0)
  expect(reported?.filesIndexed).toBe(2)

  harness.write((db: SyncDatabase) =>
    db.prepare('DELETE FROM files WHERE path = ?').run(transcriptPath(FIRST))
  )
  expect(indexer?.status().filesIndexed).toBe(1)
})

it('S2: retires a file deleted right after the opening sweep', async () => {
  await writeClaudeTranscript(transcriptPath(FIRST), ['going'], FIRST)
  await writeClaudeTranscript(transcriptPath(SECOND), ['staying'], SECOND)
  await newIndexer().start()

  await rm(transcriptPath(FIRST))
  await nextCycle()

  expect(fileTable()).toHaveLength(1)
})

it('S2: retires a file deleted right after a cycle', async () => {
  await writeClaudeTranscript(transcriptPath(FIRST), ['going'], FIRST)
  await writeClaudeTranscript(transcriptPath(SECOND), ['staying'], SECOND)
  await newIndexer().start()
  await nextCycle()

  await rm(transcriptPath(FIRST))
  await nextCycle()

  expect(fileTable()).toHaveLength(1)
})

it('S2: retires a file deleted right after a periodic sweep', async () => {
  await writeClaudeTranscript(transcriptPath(FIRST), ['going'], FIRST)
  await writeClaudeTranscript(transcriptPath(SECOND), ['staying'], SECOND)
  await newIndexer({ fullSweepEveryCycles: 2 }).start()
  await nextCycle()
  await nextCycle()
  // The third pass is the periodic sweep; the file goes the moment it ends.
  await nextCycle()

  await rm(transcriptPath(FIRST))
  await nextCycle()

  expect(fileTable()).toHaveLength(1)
})

it('S2: retires a file deleted while a pass was out of time', async () => {
  await writeClaudeTranscript(transcriptPath(FIRST), ['going'], FIRST)
  await writeClaudeTranscript(transcriptPath(SECOND), ['staying'], SECOND)
  await writeClaudeTranscript(transcriptPath(THIRD), ['also staying'], THIRD)
  // One transcript a pass: the opening sweep leaves two of the three unread.
  clock.costPerNowMs = 1_000
  await newIndexer({ passDeadlineMs: 1_000 }).start()
  expect(fileTable()).toHaveLength(1)

  await rm(transcriptPath(FIRST))
  await nextCycle()
  await nextCycle()

  expect((fileTable() as { path: string }[]).map((row) => row.path)).not.toContain(
    transcriptPath(FIRST)
  )
})

it.skipIf(!CAN_DENY_READ)(
  'S3: stops reading a file that fails three times at one stat',
  async () => {
    const path = transcriptPath(FIRST)
    await writeClaudeTranscript(path, ['behind the wrong mode bits'], FIRST)
    await chmod(path, 0o000)
    try {
      await newIndexer().start()
      for (let cycle = 0; cycle < 4; cycle++) {
        await nextCycle()
      }

      const row = harness.read((db: SyncDatabase) =>
        db.prepare('SELECT state, fail_count AS failCount FROM files WHERE path = ?').get(path)
      ) as { state: string; failCount: number }
      expect(row).toEqual({ state: 'failed', failCount: 3 })
      expect(indexer?.status()).toMatchObject({ filesFailed: 1, phase: 'degraded' })

      await chmod(path, 0o644)
      const later = new Date(Date.now() + 60_000)
      await utimes(path, later, later)
      await nextCycle()

      expect(indexer?.status()).toMatchObject({ filesIndexed: 1, filesFailed: 0 })
    } finally {
      await chmod(path, 0o644)
    }
  }
)

it('S4: leaves the file table identical across passes with no change on disk', async () => {
  await writeClaudeTranscript(transcriptPath(FIRST), ['one'], FIRST)
  await writeClaudeTranscript(transcriptPath(SECOND), ['two'], SECOND)
  await newIndexer({ fullSweepEveryCycles: 2 }).start()

  const afterSweep = fileTable()
  await nextCycle()
  expect(fileTable()).toEqual(afterSweep)
  await nextCycle()
  expect(fileTable()).toEqual(afterSweep)
  // Including across the periodic sweep, which reads the same rows again.
  await nextCycle()
  expect(fileTable()).toEqual(afterSweep)
  expect(errors).toEqual([])
})

it('S5: leaves the store consistent when a close interrupts a pass', async () => {
  await writeClaudeTranscript(transcriptPath(FIRST), ['one'], FIRST)
  await writeClaudeTranscript(transcriptPath(SECOND), ['two'], SECOND)
  await writeClaudeTranscript(transcriptPath(THIRD), ['three'], THIRD)
  newIndexer()
  let closed = false
  clock.onNow = () => {
    if (closed || fileTable().length === 0) {
      return
    }
    closed = true
    indexer?.close()
  }
  await indexer?.start()
  await indexer?.settled()
  clock.onNow = null

  const interrupted = fileTable()
  expect(interrupted.length).toBeGreaterThan(0)
  expect(interrupted.length).toBeLessThan(3)
  expect(errors).toEqual([])

  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await newIndexer().start()

  expect(indexer?.status()).toMatchObject({ filesIndexed: 3, filesDue: 0, filesFailed: 0 })
})
