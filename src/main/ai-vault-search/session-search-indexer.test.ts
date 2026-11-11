import './session-search-worker.test-fixture'
import {
  notifySessionSearchFileChange,
  notifySessionSearchRootChanges
} from './session-search-watcher.test-fixture'
import { mkdirSync, rmSync } from 'node:fs'
import { appendFile, chmod, mkdir, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/parse-cache/session-parse-cache-store'
import { resetTranscriptConsumersForTests } from '../ai-vault/transcripts/session-transcript-consumers'
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
function readsPerPass(files: number): { passDeadlineMs: number; discoveryDeadlineMs: number } {
  clock.costPerNowMs = 1_000
  return { passDeadlineMs: files * 1_000, discoveryDeadlineMs: Infinity }
}

async function nextCycle(): Promise<void> {
  notifySessionSearchRootChanges()
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
  notifySessionSearchFileChange(path)
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

  await indexer?.close()
  await newIndexer({ historyDays: null, recentPerAgent: 1 }).start()
  expect(sessionsMatching('ancient')).toEqual([OTHER_SESSION_ID])

  await indexer?.close()
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

it('fills an empty index over a warm session-list cache on the first reconcile', async () => {
  await startAfterASweep()
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['scanned before the index existed'], SESSION_ID)
  await parseTranscript(path)

  await indexer?.reconcile()

  expect(sessionsMatching('scanned')).toEqual([SESSION_ID])
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

it.skipIf(!CAN_DENY_READ)('stops re-reading a transcript it cannot read', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['a session behind the wrong mode bits'], SESSION_ID)
  await chmod(path, 0o000)
  try {
    await newIndexer().start()
    for (let cycle = 0; cycle < 4; cycle++) {
      clock.advance(INTERVAL_MS)
      await indexer?.settled()
    }

    expect(indexer?.status()).toMatchObject({ filesDue: 0, filesFailed: 1, phase: 'degraded' })
    expect(rowFor(path)?.failCount).toBeGreaterThanOrEqual(3)

    // A changed stat releases the failed-read hold; chmod alone does not change the freshness key.
    await chmod(path, 0o644)
    const later = new Date(Date.now() + 60_000)
    await utimes(path, later, later)
    notifySessionSearchFileChange(path)
    await nextCycle()

    expect(sessionsMatching('mode')).toEqual([SESSION_ID])
    expect(indexer?.status()).toMatchObject({ filesFailed: 0, phase: 'current' })
  } finally {
    await chmod(path, 0o644)
  }
})

it('releases the database path when the open itself throws', async () => {
  // A directory at the database path makes opening fail without leaving an ownership claim.
  mkdirSync(harness.databasePath, { recursive: true })
  await expect(newIndexer().initialize()).rejects.toThrow()

  rmSync(harness.databasePath, { recursive: true, force: true })
  await expect(newIndexer().initialize()).resolves.toBeUndefined()
})

it('re-reads a file a chunked read left half written, and settles it in one pass', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['the committed half'], SESSION_ID)
  await newIndexer().start()
  const whole = (await stat(path)).size
  expect(indexedByteOffset(path)).toBe(whole)
  await indexer?.close()

  plantPartialCursor(path)
  await newIndexer().start()

  expect(indexedByteOffset(path)).toBe(whole)
  expect(fileState(path)).toBe('current')
  expect(indexer?.status().phase).toBe('current')
  await indexer?.close()

  // Growing a partially indexed file must force a whole read rather than offer a declined append.
  plantPartialCursor(path)
  await appendFile(path, `${claudeLines(['the lost half'], SESSION_ID, 10).join('\n')}\n`)
  await newIndexer().start()

  expect(sessionsMatching('lost')).toEqual([SESSION_ID])
  expect(indexer?.status()).toMatchObject({ filesDue: 0, phase: 'current' })
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
  await indexer?.close()
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

// A missing configured root prevents retirement even when its parent is readable and empty.

it('keeps rows under no configured root, and retires them only when gone', async () => {
  const moved = transcriptPath()
  await writeClaudeTranscript(moved, ['a session in the old profile'], SESSION_ID)
  await newIndexer().start()
  await indexer?.close()
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

it('stops everything on close, including work already queued', async () => {
  await writeClaudeTranscript(transcriptPath(), ['indexed before the close'], SESSION_ID)
  await newIndexer().start()

  const queued = indexer?.reconcile({ full: true })
  await indexer?.close()
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

it('does not charge slow discovery against the read budget', async () => {
  for (const session of [SESSION_ID, OTHER_SESSION_ID]) {
    await writeClaudeTranscript(transcriptPath(session), [`changed session ${session}`], session)
  }
  await newIndexer({
    passDeadlineMs: 5_000,
    resolveRoots: async () => {
      clock.advance(10_000)
      return harness.roots
    }
  }).start()

  expect(indexer?.status()).toMatchObject({ filesIndexed: 2, filesDue: 0, phase: 'current' })
})

it('leaves deferred recent reads to the next cycle instead of forcing a full sweep', async () => {
  let sweeps = 0
  await startAfterASweep({
    ...readsPerPass(1),
    resolveRoots: async () => {
      sweeps += 1
      return harness.roots
    }
  })
  for (const session of [SESSION_ID, OTHER_SESSION_ID]) {
    await writeClaudeTranscript(transcriptPath(session), [`recent session ${session}`], session)
  }

  await nextCycle()
  expect(sessionsMatching('recent')).toHaveLength(1)
  await nextCycle()
  expect(sessionsMatching('recent')).toHaveLength(2)
  expect(sweeps).toBe(1)
})

it.skipIf(!CAN_DENY_READ)('retires a deleted file behind a block of unreadable rows', async () => {
  // Keep the root nonempty so empty-root grace cannot mask retirement behavior.
  await writeClaudeTranscript(transcriptPath(), ['a live conversation'], SESSION_ID)
  const locked = join(harness.roots.claudeProjectsDir ?? '', 'locked')
  await mkdir(locked, { recursive: true })
  await newIndexer().initialize()

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

it('holds out a repeatedly rejected write while other files continue indexing', async () => {
  const broken = transcriptPath()
  await writeClaudeTranscript(broken, ['rejectedneedle'], SESSION_ID)
  await writeClaudeTranscript(transcriptPath(OTHER_SESSION_ID), ['healthyneedle'], OTHER_SESSION_ID)
  const subject = newIndexer()
  await subject.initialize()
  harness.write((db) =>
    db.exec(`CREATE TRIGGER reject_one_file BEFORE INSERT ON messages
    WHEN (SELECT file_path FROM sessions WHERE id=NEW.session_row_id) LIKE '%${SESSION_ID}%'
    BEGIN SELECT RAISE(ABORT, 'rejected fixture write'); END`)
  )
  await subject.start()
  for (let pass = 0; pass < 3; pass++) {
    clock.advance(INTERVAL_MS)
    await subject.settled()
  }
  expect(rowFor(broken)).toEqual({ state: 'failed', failCount: 3 })
  expect(sessionsMatching('healthyneedle')).toEqual([OTHER_SESSION_ID])
  expect(sessionsMatching('rejectedneedle')).toEqual([])
  await appendFile(
    transcriptPath(OTHER_SESSION_ID),
    `${claudeLines(['continuedneedle'], OTHER_SESSION_ID, 10).join('\n')}\n`
  )
  notifySessionSearchFileChange(transcriptPath(OTHER_SESSION_ID))
  clock.advance(INTERVAL_MS)
  await subject.settled()
  expect(sessionsMatching('continuedneedle')).toEqual([OTHER_SESSION_ID])
  expect(rowFor(broken)).toEqual({ state: 'failed', failCount: 3 })
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
