import { appendFile, chmod, mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { asRecord } from '../ai-vault/session-scanner-record-value'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  claudeLines,
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  renameReplaceTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'

// chmod cannot deny reads to root or reliably enforce mode bits on Windows.
const CAN_DENY_READ = process.platform !== 'win32' && process.getuid?.() !== 0
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

let harness: SessionSearchIndexerHarness
let indexer: SessionSearchIndexer | null
let errors: unknown[]

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  errors = []
  harness = await openSessionSearchIndexerHarness('ss-restart')
  indexer = null
})

afterEach(async () => {
  indexer?.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness.cleanup()
})

function newIndexer(): SessionSearchIndexer {
  indexer = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock: new FakeSessionSearchClock(),
    reconcileIntervalMs: 20_000,
    onError: (error) => errors.push(error)
  })
  return indexer
}

function transcriptPath(): string {
  return join(harness.claudeProjectDir, `${SESSION_ID}.jsonl`)
}

function sessionsMatching(term: string): unknown[] {
  return harness.read((db: SyncDatabase) =>
    db
      .prepare(
        `SELECT DISTINCT s.session_id AS id FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_row_id
         WHERE messages_fts MATCH ? ORDER BY s.session_id`
      )
      .all(term)
      .map((row) => asRecord(row)?.id)
  )
}

function fileRow(path: string): Record<string, unknown> | null {
  return harness.read((db: SyncDatabase) =>
    asRecord(
      db
        .prepare(
          'SELECT state, fail_count AS failCount, byte_offset AS byteOffset FROM files WHERE path = ?'
        )
        .get(path)
    )
  )
}

function fileState(path: string): unknown {
  return fileRow(path)?.state
}

function indexedByteOffset(path: string): unknown {
  return fileRow(path)?.byteOffset
}

function messageIds(): unknown[] {
  return harness.read((db: SyncDatabase) =>
    db
      .prepare('SELECT id FROM messages ORDER BY id')
      .all()
      .map((row) => asRecord(row)?.id)
  )
}

function lines(turns: readonly string[], startIndex = 0): string {
  return `${claudeLines(turns, SESSION_ID, startIndex).join('\n')}\n`
}

/** Index, then drop in-memory parser resume points as an app restart does. */
async function indexThenRestart(path: string, content: string): Promise<unknown[]> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  await newIndexer().start()
  const ids = messageIds()
  indexer?.close()
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  return ids
}

it('appends to its own rows when a transcript grows after a restart', async () => {
  const path = transcriptPath()
  const before = await indexThenRestart(path, lines(['indexed before the restart']))

  await appendFile(path, lines(['quarantine after restart'], 10))
  await newIndexer().start()

  const after = messageIds()
  expect(after.slice(0, before.length)).toEqual(before)
  expect(after).toHaveLength(before.length + 2)
  expect(sessionsMatching('restart')).toEqual([SESSION_ID])
  expect(sessionsMatching('quarantine')).toEqual([SESSION_ID])
  expect(fileState(path)).toBe('current')
  expect(indexedByteOffset(path)).toBe((await stat(path)).size)
  expect(errors).toEqual([])
})

it('appends a line that was a partial tail at the restart once it completes', async () => {
  const path = transcriptPath()
  const tail = lines(['completed tail line'], 10)
  const before = await indexThenRestart(path, lines(['complete line']) + tail.slice(0, 20))

  await appendFile(path, tail.slice(20) + lines(['grown afterwards'], 20))
  await newIndexer().start()

  expect(messageIds().slice(0, before.length)).toEqual(before)
  expect(sessionsMatching('completed')).toEqual([SESSION_ID])
  expect(sessionsMatching('grown')).toEqual([SESSION_ID])
  expect(indexedByteOffset(path)).toBe((await stat(path)).size)
})

it.each([
  {
    name: 'an equal-length in-place rewrite',
    rewrite: (path: string) => writeFile(path, lines(['replaced']) + lines(['and grew'], 10))
  },
  {
    name: 'a truncate that regrows past the old cursor',
    rewrite: (path: string) =>
      writeFile(path, lines(['replaced']) + lines(['and grew much longer than before'], 10))
  },
  {
    name: 'a rewrite whose line now spans the old cursor',
    rewrite: (path: string) => writeFile(path, lines([`replaced ${'x'.repeat(400)}`]))
  },
  {
    name: 'a rename onto a new inode',
    rewrite: async (path: string) => {
      await renameReplaceTranscript(path, ['replaced'], SESSION_ID)
      await appendFile(path, lines(['and grew'], 10))
    }
  }
])('replaces stale rows after a restart when the prefix changed: $name', async ({ rewrite }) => {
  const path = transcriptPath()
  await indexThenRestart(path, lines(['obsolete']))

  await rewrite(path)
  await newIndexer().start()
  await indexer?.reconcile()

  expect(sessionsMatching('obsolete')).toEqual([])
  expect(sessionsMatching('replaced')).toEqual([SESSION_ID])
  expect(fileState(path)).toBe('current')
  expect(indexedByteOffset(path)).toBe((await stat(path)).size)
  expect(errors).toEqual([])
})

it.skipIf(!CAN_DENY_READ)(
  'counts a failed read after a restart toward holding the file out',
  async () => {
    const path = transcriptPath()
    await indexThenRestart(path, lines(['indexed before the restart']))
    await appendFile(path, lines(['unreadable growth'], 10))
    await chmod(path, 0o000)
    try {
      await newIndexer().start()
      expect(fileRow(path)).toMatchObject({ state: 'failed', failCount: 1 })
    } finally {
      await chmod(path, 0o644)
    }
  }
)

it('appends after a restart across a prefix of several read chunks ending in a partial line', async () => {
  const path = transcriptPath()
  const turns = Array.from({ length: 400 }, (_, turn) => `bulk turn ${turn} ${'y'.repeat(200)}`)
  const tail = lines(['spanning tail line'], 1_000)
  const prefix = lines(turns)
  expect(Buffer.byteLength(prefix)).toBeGreaterThan(3 * 64 * 1024)
  const before = await indexThenRestart(path, prefix + tail.slice(0, 30))

  await appendFile(path, tail.slice(30) + lines(['grown afterwards'], 2_000))
  await newIndexer().start()

  expect(messageIds().slice(0, before.length)).toEqual(before)
  expect(sessionsMatching('spanning')).toEqual([SESSION_ID])
  expect(sessionsMatching('grown')).toEqual([SESSION_ID])
  expect(indexedByteOffset(path)).toBe((await stat(path)).size)
})
