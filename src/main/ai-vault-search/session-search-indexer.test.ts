import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { appendFile, chmod, mkdir, rm, stat, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchIndexer } from './session-search-indexer'
import { removeSessionSearchDatabase } from './session-search-schema'
import { parseTranscript } from './session-search-transcript-fixtures'
import {
  claudeLines,
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  renameReplaceTranscript,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'

const INTERVAL_MS = 20_000
// chmod cannot deny reads to root or reliably enforce mode bits on Windows.
const CAN_DENY_READ = process.platform !== 'win32' && process.getuid?.() !== 0
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OTHER_SESSION_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const SETTLED_SESSION_ID = 'dddddddd-cccc-4ddd-8eee-ffffffffffff'

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
  indexer?.close()
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

function indexedMessageCount(): number {
  const row = harness.read((db: SyncDatabase) =>
    db.prepare('SELECT count(*) AS n FROM messages').get()
  )
  return row && typeof row === 'object' && 'n' in row && typeof row.n === 'number' ? row.n : -1
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

function indexedSessionCount(): number {
  return harness.read(
    (db: SyncDatabase) =>
      (db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n
  )
}

function rowFor(path: string) {
  return harness.read((db: SyncDatabase) =>
    db.prepare('SELECT state, fail_count AS failCount FROM files WHERE path = ?').get(path)
  ) as { state: string; failCount: number } | undefined
}

function fileState(path: string): string | undefined {
  return rowFor(path)?.state
}

function indexedByteOffset(path: string): number | undefined {
  return harness.read(
    (db: SyncDatabase) =>
      (
        db.prepare('SELECT byte_offset AS offset FROM files WHERE path = ?').get(path) as
          | { offset: number }
          | undefined
      )?.offset
  )
}

function plantPartialCursor(path: string): void {
  harness.write((db: SyncDatabase) =>
    db.prepare('UPDATE files SET byte_offset = -1 WHERE path = ?').run(path)
  )
}

function indexedCursor(path: string): { mtime_ms: number; size_bytes: number } | undefined {
  return harness.read(
    (db: SyncDatabase) =>
      db.prepare('SELECT mtime_ms, size_bytes FROM files WHERE path = ?').get(path) as
        | { mtime_ms: number; size_bytes: number }
        | undefined
  )
}

function transcriptPath(name = SESSION_ID): string {
  return join(harness.claudeProjectDir, `${name}.jsonl`)
}

/** Pre-index a future-dated transcript so later cycles skip it but keep it in the recency window. */
async function startAfterASweep(
  overrides: Partial<ConstructorParameters<typeof SessionSearchIndexer>[0]> = {}
): Promise<void> {
  const settled = transcriptPath(SETTLED_SESSION_ID)
  await writeClaudeTranscript(settled, ['a conversation from before'], SETTLED_SESSION_ID)
  // Recency uses real file mtimes rather than the fake retention clock.
  const ahead = new Date(Date.now() + 3_600_000)
  await utimes(settled, ahead, ahead)
  await newIndexer(overrides).start()
}

/** Spend one fake second per clock check to limit each pass to the requested number of reads. */
function readsPerPass(files: number): { passDeadlineMs: number } {
  clock.costPerNowMs = 1_000
  return { passDeadlineMs: files * 1_000 }
}

async function nextCycle(): Promise<void> {
  clock.advance(INTERVAL_MS)
  await indexer?.settled()
}

it('reflects a grown transcript within one reconcile interval', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['find the flaky terminal reattach'], SESSION_ID)
  await newIndexer().start()
  expect(sessionsMatching('reattach')).toEqual([SESSION_ID])
  expect(sessionsMatching('quarantine')).toEqual([])

  await appendFile(
    path,
    `${claudeLines(['quarantine the leaking pty'], SESSION_ID, 10).join('\n')}\n`
  )
  await nextCycle()

  expect(sessionsMatching('quarantine')).toEqual([SESSION_ID])
  expect(errors).toEqual([])
})

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

it('retires a deleted transcript within one reconcile interval', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['a session about to be deleted'], SESSION_ID)
  await writeClaudeTranscript(
    transcriptPath(OTHER_SESSION_ID),
    ['a surviving session'],
    OTHER_SESSION_ID
  )
  await newIndexer().start()
  await nextCycle()
  expect(sessionsMatching('deleted')).toEqual([SESSION_ID])

  await rm(path)
  await nextCycle()

  expect(sessionsMatching('deleted')).toEqual([])
  expect(sessionsMatching('surviving')).toEqual([OTHER_SESSION_ID])
})

it.skipIf(!CAN_DENY_READ)(
  'keeps rows for a source it cannot stat, because loss of contact is not deletion',
  async () => {
    const path = transcriptPath()
    await writeClaudeTranscript(path, ['an unverifiable session'], SESSION_ID)
    await newIndexer().start()
    await nextCycle()

    await chmod(harness.claudeProjectDir, 0o000)
    try {
      await nextCycle()
      expect(sessionsMatching('unverifiable')).toEqual([SESSION_ID])
    } finally {
      await chmod(harness.claudeProjectDir, 0o755)
    }
  }
)

it('resumes after close and reopen without re-reading what it already indexed', async () => {
  await writeClaudeTranscript(transcriptPath(), ['first indexed session'], SESSION_ID)
  await writeClaudeTranscript(
    transcriptPath(OTHER_SESSION_ID),
    ['second indexed session'],
    OTHER_SESSION_ID
  )
  await newIndexer().start()
  const indexedRows = harness.read((db: SyncDatabase) =>
    db.prepare('SELECT count(*) AS n FROM messages').get()
  )
  indexer?.close()

  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  const reopened = newIndexer()
  await reopened.start()

  // Read-loop tests separately verify that unchanged files are not reopened.
  expect(reopened.status()).toMatchObject({ filesIndexed: 2, filesDue: 0 })
  expect(indexedMessageCount()).toBeGreaterThan(0)
  expect(reopened.status().messagesIndexed).toBe(indexedMessageCount())
  expect(
    harness.read((db: SyncDatabase) => db.prepare('SELECT count(*) AS n FROM messages').get())
  ).toEqual(indexedRows)
  expect(sessionsMatching('indexed')).toEqual([SESSION_ID, OTHER_SESSION_ID].sort())
})

it('widens history by constructing a new instance and narrows by purging on its first sweep', async () => {
  const fresh = transcriptPath()
  const old = transcriptPath(OTHER_SESSION_ID)
  await writeClaudeTranscript(fresh, ['a recent conversation'], SESSION_ID)
  await writeClaudeTranscript(old, ['an ancient conversation'], OTHER_SESSION_ID)
  const longAgo = new Date(clock.now() - 120 * 86_400_000)
  await utimes(old, longAgo, longAgo)

  // Keep the older transcript outside the recent cycle window so only a sweep can admit it.
  await newIndexer({ historyDays: 30, recentPerAgent: 1 }).start()
  expect(sessionsMatching('recent')).toEqual([SESSION_ID])
  expect(sessionsMatching('ancient')).toEqual([])

  indexer?.close()
  await newIndexer({ historyDays: null, recentPerAgent: 1 }).start()
  expect(sessionsMatching('ancient')).toEqual([OTHER_SESSION_ID])

  indexer?.close()
  await newIndexer({ historyDays: 30, recentPerAgent: 1 }).start()
  expect(sessionsMatching('ancient')).toEqual([])
  expect(sessionsMatching('recent')).toEqual([SESSION_ID])
})

it.skipIf(!CAN_DENY_READ)(
  'names an unreadable root as degraded and keeps indexing the others',
  async () => {
    const blocked = join(harness.roots.codexSessionsDir ?? '', 'blocked')
    await mkdir(blocked, { recursive: true })
    await writeClaudeTranscript(transcriptPath(), ['a readable claude session'], SESSION_ID)
    await chmod(harness.roots.codexSessionsDir ?? '', 0o000)
    try {
      await newIndexer().start()
      const status = indexer?.status()
      expect(status?.phase).toBe('degraded')
      expect(status?.degradedRoots.map((root) => root.root)).toContain(
        harness.roots.codexSessionsDir
      )
      expect(status?.degradedRoots[0]?.reason).toBeTruthy()
      expect(sessionsMatching('readable')).toEqual([SESSION_ID])
    } finally {
      await chmod(harness.roots.codexSessionsDir ?? '', 0o755)
    }
  }
)

it('reads what one pass has time for and finishes the rest on the next', async () => {
  await startAfterASweep(readsPerPass(2))
  for (let index = 0; index < 4; index++) {
    const session = `0000000${index}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(
      transcriptPath(session),
      [`deadlined session number ${index}`],
      session
    )
  }
  await indexer?.reconcile()
  // Unread candidates have no rows yet, so only filesDue exposes this backlog.
  expect(indexer?.status()).toMatchObject({ filesIndexed: 3, filesDue: 2, phase: 'indexing' })

  await indexer?.reconcile()
  expect(sessionsMatching('deadlined')).toHaveLength(4)
  expect(indexer?.status().filesIndexed).toBe(5)

  clock.costPerNowMs = 0
  await nextCycle()
  expect(indexer?.status()).toMatchObject({ filesIndexed: 5, phase: 'current' })
})

it('fills an empty index over a warm session-list cache on the first reconcile', async () => {
  await startAfterASweep()
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['scanned before the index existed'], SESSION_ID)
  await parseTranscript(path)

  await indexer?.reconcile()

  expect(sessionsMatching('scanned')).toEqual([SESSION_ID])
})

it('fills an empty index over a warm session-list cache on the first sweep', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['scanned before the index existed'], SESSION_ID)
  await parseTranscript(path)

  await newIndexer().start()

  expect(sessionsMatching('scanned')).toEqual([SESSION_ID])
})

it('covers the whole machine over the passes that follow a truncated sweep', async () => {
  const sessions = Array.from(
    { length: 20 },
    (_unused, index) => `0000${String(index).padStart(4, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
  )
  for (const session of sessions) {
    await writeClaudeTranscript(transcriptPath(session), [`sweepwide session ${session}`], session)
  }

  await newIndexer(readsPerPass(1)).start()
  expect(indexedSessionCount()).toBeGreaterThan(0)
  expect(indexedSessionCount()).toBeLessThan(sessions.length)

  for (let cycle = 0; cycle < sessions.length; cycle++) {
    await nextCycle()
  }

  expect(indexedSessionCount()).toBe(sessions.length)
  expect(indexer?.status().phase).toBe('current')
})

it('moves the retention window with the clock instead of freezing it at construction', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['an entry that ages out'], SESSION_ID)
  const now = new Date(clock.now())
  await utimes(path, now, now)
  await newIndexer({ historyDays: 1 }).start()
  expect(sessionsMatching('ages')).toEqual([SESSION_ID])

  clock.advance(3 * 86_400_000)
  await indexer?.reconcile({ full: true })

  expect(sessionsMatching('ages')).toEqual([])
  await nextCycle()
  expect(sessionsMatching('ages')).toEqual([])
})

it('retires a transcript deleted between a sweep and the cycle after it', async () => {
  const going = transcriptPath()
  const staying = transcriptPath(OTHER_SESSION_ID)
  await writeClaudeTranscript(going, ['a session deleted right after the sweep'], SESSION_ID)
  await writeClaudeTranscript(staying, ['a surviving session'], OTHER_SESSION_ID)
  await newIndexer().start()
  expect(sessionsMatching('deleted')).toEqual([SESSION_ID])

  await rm(going)
  await nextCycle()

  expect(sessionsMatching('deleted')).toEqual([])
  expect(sessionsMatching('surviving')).toEqual([OTHER_SESSION_ID])
})

it('keeps a sweep due when the one that was running threw', async () => {
  const older = transcriptPath(OTHER_SESSION_ID)
  await writeClaudeTranscript(older, ['an older conversation'], OTHER_SESSION_ID)
  const yesterday = new Date(Date.now() - 86_400_000)
  await utimes(older, yesterday, yesterday)
  await writeClaudeTranscript(transcriptPath(), ['the newest conversation'], SESSION_ID)

  // Only a sweep reaches the older file; the clock hook injects failure during the read loop.
  newIndexer({ recentPerAgent: 1 })
  let thrown = false
  clock.onNow = () => {
    if (thrown || indexedSessionCount() === 0) {
      return
    }
    thrown = true
    throw new Error('the sweep fell over')
  }
  await indexer?.start()
  await indexer?.settled()
  clock.onNow = null

  expect(errors.map((error) => (error as Error).message)).toEqual(['the sweep fell over'])
  expect(sessionsMatching('older')).toEqual([])

  await nextCycle()
  expect(sessionsMatching('older')).toEqual([OTHER_SESSION_ID])
})

it.skipIf(!CAN_DENY_READ)('stops re-reading a transcript it cannot read', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['a session behind the wrong mode bits'], SESSION_ID)
  await chmod(path, 0o000)
  try {
    await newIndexer().start()
    for (let cycle = 0; cycle < 4; cycle++) {
      await nextCycle()
    }

    expect(indexer?.status()).toMatchObject({ filesDue: 0, filesFailed: 1, phase: 'degraded' })
    expect(rowFor(path)?.failCount).toBeGreaterThanOrEqual(3)

    // A changed stat releases the failed-read hold; chmod alone does not change the freshness key.
    await chmod(path, 0o644)
    const later = new Date(Date.now() + 60_000)
    await utimes(path, later, later)
    await nextCycle()

    expect(sessionsMatching('mode')).toEqual([SESSION_ID])
    expect(indexer?.status()).toMatchObject({ filesFailed: 0, phase: 'current' })
  } finally {
    await chmod(path, 0o644)
  }
})

it('reports nothing to its owner when it is closed part way through a pass', async () => {
  await writeClaudeTranscript(transcriptPath(), ['one'], SESSION_ID)
  const other = transcriptPath(OTHER_SESSION_ID)
  await writeClaudeTranscript(other, ['two'], OTHER_SESSION_ID)
  const later = new Date(Date.now() + 60_000)
  await utimes(other, later, later)
  newIndexer()

  // Close between files, after the first read has committed.
  let closed = false
  clock.onNow = () => {
    if (closed || indexedSessionCount() === 0) {
      return
    }
    closed = true
    indexer?.close()
  }
  await indexer?.start()
  await indexer?.settled()
  clock.onNow = null

  expect(errors).toEqual([])
})

it('reports what it last knew after it is closed, without reading the database', async () => {
  await writeClaudeTranscript(transcriptPath(), ['indexed before the close'], SESSION_ID)
  await newIndexer().start()
  expect(indexer?.status().filesIndexed).toBe(1)

  indexer?.close()

  expect(indexer?.status()).toMatchObject({ phase: 'closed', filesIndexed: 1 })
  expect(errors).toEqual([])
})

it('releases the database path when the open itself throws', () => {
  // A directory at the database path makes opening fail without leaving an ownership claim.
  mkdirSync(harness.databasePath, { recursive: true })
  expect(() => newIndexer()).toThrow()

  rmSync(harness.databasePath, { recursive: true, force: true })
  expect(() => newIndexer()).not.toThrow()
})

it('refuses a second indexer on a database one already owns', () => {
  newIndexer()
  expect(() => newIndexer()).toThrow(/already has a live indexer/)
})

it('re-reads a file a chunked read left half written, and settles it in one pass', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['the committed half'], SESSION_ID)
  await newIndexer().start()
  const whole = (await stat(path)).size
  expect(indexedByteOffset(path)).toBe(whole)
  indexer?.close()

  plantPartialCursor(path)
  await newIndexer().start()

  expect(indexedByteOffset(path)).toBe(whole)
  expect(fileState(path)).toBe('current')
  expect(indexer?.status().phase).toBe('current')
  indexer?.close()

  // Growing a partially indexed file must force a whole read rather than offer a declined append.
  plantPartialCursor(path)
  await appendFile(path, `${claudeLines(['the lost half'], SESSION_ID, 10).join('\n')}\n`)
  await newIndexer().start()

  expect(sessionsMatching('lost')).toEqual([SESSION_ID])
  expect(indexer?.status()).toMatchObject({ filesDue: 0, phase: 'current' })
})

it('reports closed once it is closed, whatever it was doing before', async () => {
  await writeClaudeTranscript(transcriptPath(), ['before the close'], SESSION_ID)
  await newIndexer().start()
  expect(indexer?.status().phase).toBe('current')
  indexer?.close()
  expect(indexer?.status().phase).toBe('closed')
})

it('reads a deferred file at its current stat, not the one the pass first saw', async () => {
  await startAfterASweep(readsPerPass(1))
  const older = transcriptPath(OTHER_SESSION_ID)
  await writeClaudeTranscript(older, ['the deferred conversation'], OTHER_SESSION_ID)
  await writeClaudeTranscript(transcriptPath(), ['the newer conversation'], SESSION_ID)
  const ahead = new Date((await stat(transcriptPath())).mtimeMs + 60_000)
  await utimes(transcriptPath(), ahead, ahead)

  await indexer?.reconcile()
  expect(rowFor(older)).toBeUndefined()

  await appendFile(
    older,
    `${claudeLines(['appended while deferred'], OTHER_SESSION_ID, 10).join('\n')}\n`
  )
  await indexer?.reconcile()

  expect(sessionsMatching('appended')).toEqual([OTHER_SESSION_ID])
  const cursor = indexedCursor(older)
  const current = await stat(older)
  expect(cursor).toEqual({ mtime_ms: current.mtimeMs, size_bytes: current.size })
})

it('reads a declined file at its current stat, not the one it was recorded with', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['the recorded conversation'], SESSION_ID)
  await newIndexer().start()

  // Retain the session-list cursor while deleting the index to force an append the consumer must decline.
  indexer?.close()
  removeSessionSearchDatabase(harness.databasePath)
  newIndexer()
  await appendFile(path, `${claudeLines(['declined turn'], SESSION_ID, 10).join('\n')}\n`)
  await parseTranscript(path)
  expect(indexer?.status().filesIndexed).toBe(0)

  await appendFile(path, `${claudeLines(['later turn'], SESSION_ID, 20).join('\n')}\n`)
  await indexer?.start()
  await nextCycle()

  expect(sessionsMatching('later')).toEqual([SESSION_ID])
  const current = await stat(path)
  expect(indexedCursor(path)).toEqual({ mtime_ms: current.mtimeMs, size_bytes: current.size })
})

it.skipIf(!CAN_DENY_READ)(
  'keeps an unlistable root through the cycles that follow the sweep',
  async () => {
    await writeClaudeTranscript(transcriptPath(), ['a session on a removable volume'], SESSION_ID)
    await newIndexer().start()
    expect(sessionsMatching('removable')).toEqual([SESSION_ID])

    await chmod(harness.roots.claudeProjectsDir ?? '', 0o000)
    try {
      await indexer?.reconcile({ full: true })
      expect(sessionsMatching('removable')).toEqual([SESSION_ID])

      await nextCycle()
      expect(sessionsMatching('removable')).toEqual([SESSION_ID])
      expect(indexer?.status().phase).toBe('degraded')
    } finally {
      await chmod(harness.roots.claudeProjectsDir ?? '', 0o755)
    }
  }
)

it.skipIf(!CAN_DENY_READ)('keeps an unlistable root degraded across repeated sweeps', async () => {
  await writeClaudeTranscript(transcriptPath(), ['a session on a removable volume'], SESSION_ID)
  await newIndexer().start()

  await chmod(harness.roots.claudeProjectsDir ?? '', 0o000)
  try {
    for (let sweep = 0; sweep < 5; sweep++) {
      await indexer?.reconcile({ full: true })
    }
    expect(sessionsMatching('removable')).toEqual([SESSION_ID])
    expect(indexer?.status().phase).toBe('degraded')
  } finally {
    await chmod(harness.roots.claudeProjectsDir ?? '', 0o755)
  }
})

it('keeps a root that is gone at the first sweep after a restart', async () => {
  await writeClaudeTranscript(transcriptPath(), ['a session on a removable volume'], SESSION_ID)
  await newIndexer().start()
  indexer?.close()
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

// An unmounted root that remains readable and empty is indistinguishable from intentional deletion.
it('retires an emptied configured root, one pass after it emptied', async () => {
  await writeClaudeTranscript(transcriptPath(), ['a session on the mounted volume'], SESSION_ID)
  await newIndexer().start()

  await rm(harness.claudeProjectDir, { recursive: true, force: true })
  await indexer?.reconcile({ full: true })
  expect(sessionsMatching('mounted')).toEqual([SESSION_ID])
  expect(indexer?.status().phase).toBe('degraded')

  await indexer?.reconcile({ full: true })
  expect(sessionsMatching('mounted')).toEqual([])
  expect(indexer?.status()).toMatchObject({ phase: 'current', degradedRoots: [] })
})

it('retires an emptied configured root at once on the first pass of a process', async () => {
  await writeClaudeTranscript(transcriptPath(), ['a session on the mounted volume'], SESSION_ID)
  await newIndexer().start()
  expect(sessionsMatching('mounted')).toEqual([SESSION_ID])
  indexer?.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()

  await rm(harness.claudeProjectDir, { recursive: true, force: true })
  await newIndexer().start()
  expect(sessionsMatching('mounted')).toEqual([])
})

// A missing configured root prevents retirement even when its parent is readable and empty.
it('proves nothing from an empty directory above the configured root', async () => {
  for (let index = 0; index < 3; index++) {
    const session = `0000000${index}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(transcriptPath(session), [`mounted session ${index}`], session)
  }
  await newIndexer().start()
  expect(sessionsMatching('mounted')).toHaveLength(3)
  indexer?.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()

  await rm(harness.roots.claudeProjectsDir ?? '', { recursive: true, force: true })
  await newIndexer().start()

  const status = indexer?.status()
  expect(status?.phase).toBe('degraded')
  expect(status?.degradedRoots.map((root) => root.root)).toContain(harness.roots.claudeProjectsDir)
  expect(sessionsMatching('mounted')).toHaveLength(3)
})

it('reads a root that came back on the next periodic sweep', async () => {
  await newIndexer({ recentPerAgent: 1, fullSweepEveryCycles: 2 }).start()
  expect(indexer?.status()).toMatchObject({ degradedRoots: [], filesIndexed: 0 })

  for (let index = 0; index < 3; index++) {
    const session = `0000000${index}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(transcriptPath(session), [`remounted session ${index}`], session)
  }

  await nextCycle()
  await nextCycle()
  expect(sessionsMatching('remounted')).toHaveLength(1)

  await nextCycle()
  expect(sessionsMatching('remounted')).toHaveLength(3)
})

it('keeps rows under no configured root, and retires them only when gone', async () => {
  const moved = transcriptPath()
  await writeClaudeTranscript(moved, ['a session in the old profile'], SESSION_ID)
  await newIndexer().start()
  indexer?.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()

  const elsewhere = join(harness.root, 'moved-profile')
  newIndexer({ roots: { ...harness.roots, claudeProjectsDir: elsewhere } })
  await indexer?.start()
  expect(sessionsMatching('profile')).toEqual([SESSION_ID])

  await rm(moved)
  await indexer?.reconcile({ full: true })
  expect(sessionsMatching('profile')).toEqual([])
})

it('lets a cycle retire a project directory the user deleted', async () => {
  await writeClaudeTranscript(transcriptPath(), ['a session about to vanish'], SESSION_ID)
  await newIndexer().start()

  await rm(harness.claudeProjectDir, { recursive: true, force: true })
  await indexer?.reconcile({ full: true })
  expect(sessionsMatching('vanish')).toEqual([SESSION_ID])

  await nextCycle()
  expect(sessionsMatching('vanish')).toEqual([])
  expect(indexer?.status()).toMatchObject({ phase: 'current', degradedRoots: [] })
})

it('stops everything on close, including work already queued', async () => {
  await writeClaudeTranscript(transcriptPath(), ['indexed before the close'], SESSION_ID)
  await newIndexer().start()

  const queued = indexer?.reconcile({ full: true })
  indexer?.close()
  await queued

  expect(errors).toEqual([])
  expect(clock.pendingTimers).toBe(0)
  clock.advance(5 * INTERVAL_MS)
  await indexer?.settled()
  expect(errors).toEqual([])

  const after = transcriptPath(OTHER_SESSION_ID)
  await writeClaudeTranscript(after, ['written after the close'], OTHER_SESSION_ID)
  await parseTranscript(after)
  expect(sessionsMatching('written')).toEqual([])
  expect(sessionsMatching('indexed')).toEqual([SESSION_ID])
})

it('throws the index away and rebuilds it by constructing a new instance', async () => {
  await writeClaudeTranscript(transcriptPath(), ['indexed before the clear'], SESSION_ID)
  await newIndexer().start()
  expect(existsSync(harness.databasePath)).toBe(true)

  indexer?.close()
  removeSessionSearchDatabase(harness.databasePath)
  expect(existsSync(harness.databasePath)).toBe(false)

  await newIndexer().start()
  expect(sessionsMatching('indexed')).toEqual([SESSION_ID])
})

it('refuses a reconcile before it is started and after it is closed', async () => {
  newIndexer()
  expect(() => indexer?.reconcile()).toThrow(/start\(\) first/)

  await indexer?.start()
  await indexer?.reconcile()
  indexer?.close()
  expect(() => indexer?.reconcile()).toThrow(/closed/)
})

it('stops the opening sweep at its deadline and drains the rest over the passes that follow', async () => {
  for (let index = 0; index < 5; index++) {
    const session = `0000000${index}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(transcriptPath(session), [`backlogged session ${index}`], session)
  }
  await newIndexer(readsPerPass(2)).start()
  expect(indexer?.status()).toMatchObject({
    filesIndexed: 2,
    filesDue: 3,
    phase: 'indexing',
    lastSweepCompletedAt: null
  })

  await nextCycle()
  expect(indexer?.status()).toMatchObject({ filesIndexed: 4, filesDue: 1, phase: 'indexing' })
  expect(indexer?.status().lastSweepCompletedAt).toBeNull()

  await nextCycle()
  expect(sessionsMatching('backlogged')).toHaveLength(5)
  expect(indexer?.status()).toMatchObject({ filesIndexed: 5, filesDue: 0, phase: 'current' })
  expect(indexer?.status().lastSweepCompletedAt).not.toBeNull()
})

it('sweeps on its cadence without anyone asking', async () => {
  await writeClaudeTranscript(transcriptPath(), ['the newest conversation'], SESSION_ID)
  await newIndexer({ recentPerAgent: 1, fullSweepEveryCycles: 2 }).start()

  const older = transcriptPath(OTHER_SESSION_ID)
  await writeClaudeTranscript(older, ['an older conversation'], OTHER_SESSION_ID)
  const yesterday = new Date(Date.now() - 86_400_000)
  await utimes(older, yesterday, yesterday)

  await nextCycle()
  await nextCycle()
  expect(sessionsMatching('older')).toEqual([])

  await nextCycle()
  expect(sessionsMatching('older')).toEqual([OTHER_SESSION_ID])
})

it.skipIf(!CAN_DENY_READ)('retires a deleted file behind a block of unreadable rows', async () => {
  // Keep the root nonempty so empty-root grace cannot mask retirement behavior.
  await writeClaudeTranscript(transcriptPath(), ['a live conversation'], SESSION_ID)
  const locked = join(harness.roots.claudeProjectsDir ?? '', 'locked')
  await mkdir(locked, { recursive: true })
  newIndexer()

  // Put 520 unreadable rows ahead of the deleted row to catch limits counted by rows instead of directories.
  harness.write((db: SyncDatabase) => {
    const insert = db.prepare(
      `INSERT INTO files(path, byte_offset, mtime_ms, size_bytes, state)
       VALUES (?, 0, ?, 10, 'current')`
    )
    for (let index = 0; index < 520; index++) {
      insert.run(join(locked, `locked-${index}.jsonl`), 1_700_000_000_000 + index)
    }
    return insert.run(join(harness.claudeProjectDir, 'deleted.jsonl'), 1_700_000_999_000)
  })
  const deleted = join(harness.claudeProjectDir, 'deleted.jsonl')
  const holdsDeleted = (): boolean => rowFor(deleted) !== undefined

  await chmod(locked, 0o000)
  try {
    await indexer?.start()

    expect(holdsDeleted()).toBe(false)
    expect(indexer?.status().filesIndexed).toBe(521)
    expect(indexer?.status().phase).toBe('degraded')
  } finally {
    await chmod(locked, 0o700)
  }
})

it('proves deletions for the newest rows it holds, and leaves the tail to a sweep', async () => {
  const total = 530
  const oldest = transcriptPath('00000000-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  await writeClaudeTranscript(
    oldest,
    ['the oldest session'],
    '00000000-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  )
  const longAgo = new Date(Date.now() - total * 60_000)
  await utimes(oldest, longAgo, longAgo)
  // Insert the oldest file first so table order cannot accidentally satisfy the mtime-order check.
  await newIndexer().start()

  for (let index = 1; index < total; index++) {
    const session = `0000${String(index).padStart(4, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    const path = transcriptPath(session)
    await writeClaudeTranscript(path, [`capped session ${index}`], session)
    const at = new Date(Date.now() - (total - index) * 60_000)
    await utimes(path, at, at)
  }
  await indexer?.reconcile({ full: true })
  expect(indexedSessionCount()).toBe(total)

  // 530 rows minus 12 rediscovered leaves 518 retirement candidates, exceeding the 512-row cycle cap.
  await rm(oldest)
  await nextCycle()
  expect(indexedSessionCount()).toBe(total)

  await indexer?.reconcile({ full: true })
  expect(indexedSessionCount()).toBe(total - 1)
})

it('runs another sweep when one is asked for during a sweep', async () => {
  for (let index = 0; index < 20; index++) {
    const session = `0000${String(index).padStart(4, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(transcriptPath(session), [`recent session ${index}`], session)
  }
  const late = transcriptPath(OTHER_SESSION_ID)

  // Restrict recent cycles to one file so the late, backdated transcript requires another sweep.
  newIndexer({ recentPerAgent: 1 })
  let armed = false
  // Wait for a committed row to inject the request after the pass has consumed its sweep flag.
  clock.onNow = () => {
    if (armed || indexedSessionCount() === 0) {
      return
    }
    armed = true
    mkdirSync(dirname(late), { recursive: true })
    writeFileSync(late, `${claudeLines(['a late conversation'], OTHER_SESSION_ID, 0).join('\n')}\n`)
    const backdated = new Date(Date.now() - 86_400_000)
    utimesSync(late, backdated, backdated)
    void indexer?.reconcile({ full: true })
  }
  await indexer?.start()
  await indexer?.settled()

  expect(sessionsMatching('late')).toEqual([OTHER_SESSION_ID])
})

it('hands the rest of a pass back when it runs out of wall time', async () => {
  for (let index = 0; index < 20; index++) {
    const session = `0000${String(index).padStart(4, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(transcriptPath(session), [`deadlined session ${index}`], session)
  }
  await newIndexer(readsPerPass(16)).start()

  expect(indexer?.status().filesIndexed).toBe(16)

  await nextCycle()
  expect(indexer?.status()).toMatchObject({ filesIndexed: 20, filesDue: 0 })
})
