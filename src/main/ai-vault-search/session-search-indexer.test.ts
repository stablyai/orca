import { existsSync } from 'node:fs'
import { appendFile, chmod, mkdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchIndexer } from './session-search-indexer'
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
// chmod cannot deny root, and Windows ignores the mode bits entirely, so the
// two refusal tests would assert on an unreached branch there.
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
    // Real pacing sleeps on the host's load average, which is not the
    // indexer's behaviour under test.
    pace: async () => undefined,
    onError: (error) => errors.push(error),
    ...overrides
  })
  return indexer
}

/** Sessions a published-view read returns for one term, the only legal shape. */
function sessionsMatching(term: string): string[] {
  return harness.read((db: SyncDatabase) =>
    (
      db
        .prepare(
          `SELECT DISTINCT s.session_id AS id FROM messages_fts
           JOIN visible_messages m ON m.id = messages_fts.rowid
           JOIN visible_sessions s ON s.id = m.session_row_id
           WHERE messages_fts MATCH ? ORDER BY s.session_id`
        )
        .all(term) as { id: string }[]
    ).map((row) => row.id)
  )
}

function indexedSessionCount(): number {
  return harness.read(
    (db: SyncDatabase) =>
      (db.prepare('SELECT count(*) AS n FROM visible_sessions').get() as { n: number }).n
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

/**
 * Starts the indexer over a root that already holds one indexed transcript, so
 * the opening sweep is behind us and `reconcile()` runs a cycle. It is dated
 * ahead of everything the caller writes afterwards, so it stays inside any
 * recency window and is skipped rather than read.
 */
async function startAfterASweep(
  overrides: Partial<ConstructorParameters<typeof SessionSearchIndexer>[0]> = {}
): Promise<void> {
  const settled = transcriptPath(SETTLED_SESSION_ID)
  await writeClaudeTranscript(settled, ['a conversation from before'], SETTLED_SESSION_ID)
  // Wall time, not the fake clock: recency is decided by real file mtimes.
  const ahead = new Date(Date.now() + 3_600_000)
  await utimes(settled, ahead, ahead)
  await newIndexer(overrides).start()
}

/** Advances one reconcile interval and waits for the cycle it fires. */
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
  // Same length, different inode: only the identity check can tell them apart.
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

    // The tree is gone from discovery's point of view, but the transcript itself
    // was never proven absent: an unreadable parent is not a deleted file.
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
    db.prepare('SELECT count(*) AS n FROM visible_messages').get()
  )
  indexer?.close()

  // A restart is a cold parse cache over a warm index; only the `files` table
  // can say what has already been read.
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  const reopened = newIndexer()
  await reopened.start()

  // Bytes, not files: `filesIndexed` is what the index holds, so it stays 2.
  // Zero bytes read is the claim that matters — nothing was opened again.
  expect(reopened.status()).toMatchObject({ filesIndexed: 2, bytesIndexed: 0 })
  expect(
    harness.read((db: SyncDatabase) =>
      db.prepare('SELECT count(*) AS n FROM visible_messages').get()
    )
  ).toEqual(indexedRows)
  expect(sessionsMatching('indexed')).toEqual([SESSION_ID, OTHER_SESSION_ID].sort())
})

it('restarts the backfill when the history window widens and purges when it narrows', async () => {
  const fresh = transcriptPath()
  const old = transcriptPath(OTHER_SESSION_ID)
  await writeClaudeTranscript(fresh, ['a recent conversation'], SESSION_ID)
  await writeClaudeTranscript(old, ['an ancient conversation'], OTHER_SESSION_ID)
  const longAgo = new Date(clock.now() - 120 * 86_400_000)
  await utimes(old, longAgo, longAgo)

  // Newest-one per root, so the widened-in transcript is outside the recency
  // window a cycle re-stats: only a full sweep can reach it.
  await newIndexer({ historyDays: 30, recentPerAgent: 1 }).start()
  expect(sessionsMatching('recent')).toEqual([SESSION_ID])
  expect(sessionsMatching('ancient')).toEqual([])

  // Widening cannot be served from the index: those files were never read.
  await indexer?.setHistoryDays(null)
  expect(sessionsMatching('ancient')).toEqual([OTHER_SESSION_ID])

  await indexer?.setHistoryDays(30)
  expect(sessionsMatching('ancient')).toEqual([])
  expect(sessionsMatching('recent')).toEqual([SESSION_ID])
})

it('refuses writes while paused, remembers what it declined, and bounds both queues', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['indexed before the pause'], SESSION_ID)
  await newIndexer({ pendingLimit: 3 }).start()

  indexer?.pause()
  expect(indexer?.status().phase).toBe('paused')
  await appendFile(path, `${claudeLines(['written while paused'], SESSION_ID, 10).join('\n')}\n`)
  // The session list keeps scanning while the index is paused; the store has to
  // refuse those writes itself, not merely because no timer is armed.
  await parseTranscript(path)
  await nextCycle()
  expect(sessionsMatching('paused')).toEqual([])
  // A pause is the window in which reads are declined, so forgetting them would
  // lose exactly the files the pause covered.
  expect(indexer?.status().filesPending).toBe(1)

  // A caller can keep invalidating right through the pause; that queue is capped.
  indexer?.invalidate(['/a', '/b', '/c', '/d', '/e'])
  const paused = indexer?.status()
  expect(paused?.filesPending).toBe(4)
  expect(paused?.droppedPending).toBe(2)

  await indexer?.resume()
  expect(sessionsMatching('paused')).toEqual([SESSION_ID])
  // The declined read is settled; the three invented paths cannot be resolved
  // to any agent, so they stay queued and counted rather than disappearing.
  expect(indexer?.status()).toMatchObject({ filesPending: 3, droppedPending: 2 })
  expect(indexer?.status().phase).not.toBe('paused')
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
      // A degraded root is not a degraded index: everything else still lands.
      expect(sessionsMatching('readable')).toEqual([SESSION_ID])
    } finally {
      await chmod(harness.roots.codexSessionsDir ?? '', 0o755)
    }
  }
)

it('spends a cycle budget and rolls the rest into the next cycle', async () => {
  // The sweep is behind us, so this is the reconciler having to fit four files
  // into a two-file allowance.
  await startAfterASweep({ budget: { files: 2, bytes: 64 * 1024 } })
  for (let index = 0; index < 4; index++) {
    await writeClaudeTranscript(
      transcriptPath(`0000000${index}-bbbb-4ccc-8ddd-eeeeeeeeeeee`),
      [`budgeted session number ${index}`],
      `0000000${index}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    )
  }
  await indexer?.reconcile()
  expect(indexer?.status().filesIndexed).toBe(3)
  expect(indexer?.status().filesPending).toBe(2)

  await indexer?.reconcile()
  expect(indexer?.status().filesPending).toBe(0)
  expect(sessionsMatching('budgeted')).toHaveLength(4)
})

// First enablement inside a running app is the normal case, not an edge: the
// session list has been scanning since launch, so every transcript already has
// a cursor sitting at its current stat and the index has nothing at all.
it('fills an empty index over a warm session-list cache on the first reconcile', async () => {
  await startAfterASweep()
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['scanned before the index existed'], SESSION_ID)
  // An ordinary parse now reuses its cached fold and opens no file, so no
  // consumer is asked and there is nothing for a decline to record.
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

it('reports the rows a crashed writer left behind on the next open', async () => {
  await writeClaudeTranscript(transcriptPath(), ['a crashed write'], SESSION_ID)
  await newIndexer().start()
  expect(indexer?.status().recoveredRows).toBe(0)
  indexer?.close()

  // What a killed writer leaves: a staging session nothing published.
  harness.write((db: SyncDatabase) => {
    db.prepare(
      "INSERT INTO sessions(index_ready,agent,session_id,file_path,title,resume_command) VALUES (0,'claude','','/gone','','')"
    ).run()
    return null
  })
  resetTranscriptConsumersForTests()
  expect(newIndexer().status().recoveredRows).toBeGreaterThan(0)
})

// Finding 1: a pause part way through a sweep used to abandon it. The flag was
// cleared on entry, the abort was swallowed, and resume only re-swept when the
// pause outlasted an interval, so the rest of the machine stayed unindexed.
it('finishes a sweep that a pause interrupted, without the clock moving', async () => {
  const sessions = Array.from(
    { length: 20 },
    (_unused, index) => `0000${String(index).padStart(4, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
  )
  for (const session of sessions) {
    await writeClaudeTranscript(transcriptPath(session), [`sweepwide session ${session}`], session)
  }

  let paced = 0
  newIndexer({
    // Pause at the first pacing point, part way through the sweep.
    pace: async () => {
      if (paced++ === 0) {
        indexer?.pause()
      }
    }
  })
  await indexer?.start()
  expect(indexedSessionCount()).toBeGreaterThan(0)
  expect(indexedSessionCount()).toBeLessThan(sessions.length)

  await indexer?.resume()
  for (let cycle = 0; cycle < 5; cycle++) {
    await nextCycle()
  }

  expect(indexedSessionCount()).toBe(sessions.length)
  expect(indexer?.status().phase).toBe('current')
})

// Finding 2: the store's cutoff was set once at construction while purges used
// a fresh one, so a sweep deleted the row and the accept check re-indexed it.
it('moves the retention window with the clock instead of freezing it at construction', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['an entry that ages out'], SESSION_ID)
  // Dated on the same clock the retention window is measured against.
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

// Finding 3: an invalidated path outside the recency window was resolved only
// through rows the index already held, so anything else was dropped unread.
it('reads an invalidated transcript from outside the recency window', async () => {
  // Newest-one per root, and the index has never seen either file below.
  await startAfterASweep({ recentPerAgent: 1 })
  const older = transcriptPath(OTHER_SESSION_ID)
  await writeClaudeTranscript(older, ['the older conversation'], OTHER_SESSION_ID)
  await writeClaudeTranscript(transcriptPath(), ['the newer conversation'], SESSION_ID)
  const newer = await stat(transcriptPath())
  const ahead = new Date(newer.mtimeMs + 60_000)
  await utimes(transcriptPath(), ahead, ahead)

  indexer?.invalidate([older])
  await indexer?.reconcile()

  expect(sessionsMatching('older')).toEqual([OTHER_SESSION_ID])
  expect(indexer?.status().filesPending).toBe(0)
})

// Finding 4d: a declined read returns without throwing, and counting it as
// indexed is how a status claims files the index does not hold.
it('counts a file as indexed only when the index actually took it', async () => {
  await writeClaudeTranscript(transcriptPath(), ['a real read'], SESSION_ID)
  await newIndexer().start()
  const afterSweep = indexer?.status().bytesIndexed ?? 0
  expect(afterSweep).toBeGreaterThan(0)

  // Nothing changed, so the next cycle reads nothing and must claim nothing.
  await indexer?.reconcile()
  expect(indexer?.status()).toMatchObject({ filesIndexed: 1, bytesIndexed: afterSweep })
})

it('reports closed once it is closed, whatever it was doing before', async () => {
  await writeClaudeTranscript(transcriptPath(), ['before the close'], SESSION_ID)
  await newIndexer().start()
  expect(indexer?.status().phase).toBe('current')
  indexer?.close()
  expect(indexer?.status().phase).toBe('closed')
})

// Finding 6: a queued entry carries the stat it was recorded with. Reading at
// that stat writes a cursor describing a file that no longer looks like this,
// so the next cycle distrusts it and re-reads it, forever.
it('reads a queued file at its current stat, not the one it was queued with', async () => {
  // One file per cycle, so the older one is deferred carrying this stat.
  await startAfterASweep({ budget: { files: 1, bytes: 64 * 1024 } })
  const older = transcriptPath(OTHER_SESSION_ID)
  await writeClaudeTranscript(older, ['the deferred conversation'], OTHER_SESSION_ID)
  await writeClaudeTranscript(transcriptPath(), ['the newer conversation'], SESSION_ID)
  const ahead = new Date((await stat(transcriptPath())).mtimeMs + 60_000)
  await utimes(transcriptPath(), ahead, ahead)

  await indexer?.reconcile()
  expect(indexer?.status().filesPending).toBe(1)

  await appendFile(
    older,
    `${claudeLines(['appended while queued'], OTHER_SESSION_ID, 10).join('\n')}\n`
  )
  await indexer?.reconcile()

  expect(sessionsMatching('appended')).toEqual([OTHER_SESSION_ID])
  // The cursor has to describe the file as it is now; recorded against the
  // queued stat it would be re-read on every cycle from here on.
  const cursor = indexedCursor(older)
  const current = await stat(older)
  expect(cursor).toEqual({ mtime_ms: current.mtimeMs, size_bytes: current.size })
})

// A declined read records the stat it was declined at. By the time the store
// hands it back the file has usually moved on again, and reading at the
// recorded stat writes a cursor the next cycle immediately distrusts.
it('reads a stale file at its current stat, not the one it was recorded with', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['the recorded conversation'], SESSION_ID)
  await newIndexer().start()

  indexer?.pause()
  await appendFile(path, `${claudeLines(['declined turn'], SESSION_ID, 10).join('\n')}\n`)
  // The list scan is declined while paused, so the store records this stat.
  await parseTranscript(path)
  await appendFile(path, `${claudeLines(['later turn'], SESSION_ID, 20).join('\n')}\n`)
  await indexer?.resume()

  expect(sessionsMatching('later')).toEqual([SESSION_ID])
  const current = await stat(path)
  expect(indexedCursor(path)).toEqual({ mtime_ms: current.mtimeMs, size_bytes: current.size })
})

// Round 2, item 1: the sweep kept the rows and a cycle twenty seconds later
// deleted them, because the degraded-root fence was on the sweep path only.
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

// A root that cannot be listed is never believed to be empty, however many
// times it is asked: an error is not a listing, and only a listing is proof.
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

// Round 2, item 2: a forced whole re-read of an unchanged file writes an
// identical cursor. Judging by cursor movement, that never settles: the path
// is owed forever and re-read whole on every interval.
it('settles an invalidated file that turned out not to have changed', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['unchanged after all'], SESSION_ID)
  await newIndexer().start()

  indexer?.invalidate([path])
  await indexer?.reconcile()
  expect(indexer?.status()).toMatchObject({ filesPending: 0, phase: 'current' })

  // And it stays settled: the next cycle has no reason to open it again.
  const bytes = indexer?.status().bytesIndexed
  await nextCycle()
  expect(indexer?.status()).toMatchObject({ filesPending: 0, bytesIndexed: bytes })
})

// The first sweep of every process is exactly when a volume is most likely to
// be detached, and it is the pass with nothing behind it to compare against.
it('keeps a root that is gone at the first sweep after a restart', async () => {
  await writeClaudeTranscript(transcriptPath(), ['a session on a removable volume'], SESSION_ID)
  await newIndexer().start()
  indexer?.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()

  // The volume is not there when the process comes back.
  await rm(harness.roots.claudeProjectsDir ?? '', { recursive: true, force: true })
  await newIndexer().start()

  const status = indexer?.status()
  expect(status?.phase).toBe('degraded')
  expect(status?.degradedRoots.map((root) => root.root)).toContain(harness.roots.claudeProjectsDir)
  expect(sessionsMatching('removable')).toEqual([SESSION_ID])

  // And it clears once the volume is back.
  await writeClaudeTranscript(transcriptPath(), ['a session on a removable volume'], SESSION_ID)
  await indexer?.reconcile({ full: true })
  expect(indexer?.status()).toMatchObject({ phase: 'current', degradedRoots: [] })
})

// Round 7: what the stateless walk costs, stated rather than hidden. A volume
// mounted at EXACTLY a configured root, unmounted so the mountpoint stays
// present and lists empty, is indistinguishable from a root the user emptied:
// there is no directory left whose absence could stop the walk. Inside one
// process the transition buys a pass of grace; across a restart there is no
// transition to see and the rows retire. The unmounts that actually happen are
// above the root, and the next test is the one that covers them.
it('retires an emptied configured root, one pass after it emptied', async () => {
  await writeClaudeTranscript(transcriptPath(), ['a session on the mounted volume'], SESSION_ID)
  await newIndexer().start()

  // The transcripts go; the root itself stays there and stays readable.
  await rm(harness.claudeProjectDir, { recursive: true, force: true })
  await indexer?.reconcile({ full: true })
  expect(sessionsMatching('mounted')).toEqual([SESSION_ID])
  expect(indexer?.status().phase).toBe('degraded')

  await indexer?.reconcile({ full: true })
  expect(sessionsMatching('mounted')).toEqual([])
  expect(indexer?.status()).toMatchObject({ phase: 'current', degradedRoots: [] })
})

// The same root, with no previous pass to compare against: nothing carries the
// transition across a restart, and the empty listing is proof on its own.
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

// The shape a real unmount takes: on Linux, WSL and sshfs the mountpoint is
// above the agent's root, so the root itself is missing. The walk stops at the
// root boundary and never asks the empty parent anything, which is what makes
// this hold with no memory on the first pass of a process.
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

  // The volume that carried the agent's root is gone; what it was mounted
  // under is still there, still listable, and empty of it.
  await rm(harness.roots.claudeProjectsDir ?? '', { recursive: true, force: true })
  await newIndexer().start()

  const status = indexer?.status()
  expect(status?.phase).toBe('degraded')
  expect(status?.degradedRoots.map((root) => root.root)).toContain(harness.roots.claudeProjectsDir)
  expect(sessionsMatching('mounted')).toHaveLength(3)
})

// C2's other half: a cycle only reads the newest N per agent, so a remounted
// volume would give up its newest transcript and keep the rest unreachable.
it('sweeps again when a root comes back after being absent', async () => {
  const absent = harness.roots.claudeProjectsDir ?? ''
  // Detached before anything was ever indexed, so the sweep correctly finds
  // nothing and reports no alarm.
  await newIndexer({ recentPerAgent: 1 }).start()
  expect(indexer?.status()).toMatchObject({ degradedRoots: [], filesIndexed: 0 })

  for (let index = 0; index < 3; index++) {
    const session = `0000000${index}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(transcriptPath(session), [`remounted session ${index}`], session)
  }
  expect(absent).toBeTruthy()

  // One cycle notices the root is back; the sweep it asks for reads the rest.
  await nextCycle()
  await nextCycle()

  expect(sessionsMatching('remounted')).toHaveLength(3)
})

// Round 4, item 3: rows under no configured root were immortal, refreshed by
// nothing and reported by nothing, while still answering searches.
it('reports rows under no configured root, and retires them only when gone', async () => {
  const moved = transcriptPath()
  await writeClaudeTranscript(moved, ['a session in the old profile'], SESSION_ID)
  await newIndexer().start()
  indexer?.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()

  // The profile moves: same index, a root that no longer covers those rows.
  const elsewhere = join(harness.root, 'moved-profile')
  newIndexer({ roots: { ...harness.roots, claudeProjectsDir: elsewhere } })
  await indexer?.start()
  expect(indexer?.status().orphanedFiles).toBe(1)
  // Still on disk, so the rows stay: this is a configuration problem, not a
  // licence to delete a user's history.
  expect(sessionsMatching('profile')).toEqual([SESSION_ID])

  await rm(moved)
  await indexer?.reconcile({ full: true })
  expect(indexer?.status().orphanedFiles).toBe(0)
  expect(sessionsMatching('profile')).toEqual([])
})

// Round 7 replaced "only a census may conclude" with "whoever can prove it".
// A cycle walks the same directories and reaches the same verdict, so a project
// directory the user deleted does not wait for the next sweep.
it('lets a cycle retire a project directory the user deleted', async () => {
  await writeClaudeTranscript(transcriptPath(), ['a session about to vanish'], SESSION_ID)
  await newIndexer().start()

  await rm(harness.claudeProjectDir, { recursive: true, force: true })
  // The pass that sees the root go from holding transcripts to holding none
  // gives it one pass of grace, whether it is a sweep or a cycle.
  await indexer?.reconcile({ full: true })
  expect(sessionsMatching('vanish')).toEqual([SESSION_ID])

  await nextCycle()
  expect(sessionsMatching('vanish')).toEqual([])
  expect(indexer?.status()).toMatchObject({ phase: 'current', degradedRoots: [] })
})

// Finding 8: a path sits in both queues the moment a read is declined during a
// pause and a caller then invalidates the same file. Summing them reports one
// transcript as two, and a caller has no way to tell that from two files.
it('counts a file queued in both places once', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['queued in both places'], SESSION_ID)
  await newIndexer().start()

  indexer?.pause()
  await appendFile(path, `${claudeLines(['declined turn'], SESSION_ID, 10).join('\n')}\n`)
  // The store records the declined read.
  await parseTranscript(path)
  expect(indexer?.status().filesPending).toBe(1)

  // The caller invalidates the same file: still one file owed a read.
  indexer?.invalidate([path])
  expect(indexer?.status().filesPending).toBe(1)

  // A different file is a second one, so the count is a union and not a cap.
  indexer?.invalidate([transcriptPath(OTHER_SESSION_ID)])
  expect(indexer?.status().filesPending).toBe(2)
})

// C1: `close()` disarmed the timer and aborted the task in flight, but left the
// queue running. A `clear()` queued a moment earlier would then delete the
// database, open a new one and register a consumer against it, all behind an
// indexer whose caller had finished with it.
//
// F2 is the other half of the same seam: the queued task never running is what
// `close()` is for, but `clear()` had already resolved, so a caller who asked
// for the index to be thrown away was left with it on disk. The close finishes
// the removal itself rather than reopening anything.
it('finishes a clear that was still queued when it was closed', async () => {
  await writeClaudeTranscript(transcriptPath(), ['indexed before the close'], SESSION_ID)
  await newIndexer().start()
  expect(existsSync(harness.databasePath)).toBe(true)

  // `clear()` queues the work that removes the database and opens a new one.
  const clearing = indexer?.clear()
  indexer?.close()
  await clearing

  // Removed, and not reopened: a close leaves no store and no consumer behind.
  expect(existsSync(harness.databasePath)).toBe(false)
  const after = transcriptPath(OTHER_SESSION_ID)
  await writeClaudeTranscript(after, ['written after the close'], OTHER_SESSION_ID)
  await parseTranscript(after)
  expect(existsSync(harness.databasePath)).toBe(false)
})

// I7: the backfill reads transcript bytes, so it is budgeted like every other
// pass. It plans the whole machine and hands back what its allowance had no
// room for; the passes that follow drain the plan without re-discovering.
it('budgets the backfill and drains the rest over the passes that follow', async () => {
  for (let index = 0; index < 5; index++) {
    const session = `0000000${index}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(transcriptPath(session), [`backlogged session ${index}`], session)
  }
  // One per agent in the recency window, so the cycles cannot be what reads the
  // other four: the backfill's own allowance has to.
  await newIndexer({ recentPerAgent: 1, backfillBudget: { files: 2, bytes: 1e9 } }).start()
  expect(indexer?.status()).toMatchObject({ filesIndexed: 2, filesPending: 3 })

  await nextCycle()
  expect(indexer?.status()).toMatchObject({ filesIndexed: 4, filesPending: 1 })

  await nextCycle()
  expect(sessionsMatching('backlogged')).toHaveLength(5)
  expect(indexer?.status()).toMatchObject({ filesPending: 0, phase: 'current' })
})

// I6: a purge deletes rows and compacts the database, which is exactly the work
// a pause is asking to stop. Narrowing while paused records that one is owed.
it('defers a narrowing purge until the index may write again', async () => {
  const old = transcriptPath(OTHER_SESSION_ID)
  await writeClaudeTranscript(transcriptPath(), ['a recent conversation'], SESSION_ID)
  await writeClaudeTranscript(old, ['an ancient conversation'], OTHER_SESSION_ID)
  const longAgo = new Date(clock.now() - 120 * 86_400_000)
  await utimes(old, longAgo, longAgo)
  await newIndexer().start()
  expect(sessionsMatching('ancient')).toEqual([OTHER_SESSION_ID])

  indexer?.pause()
  await indexer?.setHistoryDays(30)
  expect(sessionsMatching('ancient')).toEqual([OTHER_SESSION_ID])

  await indexer?.resume()
  expect(sessionsMatching('ancient')).toEqual([])
  expect(sessionsMatching('recent')).toEqual([SESSION_ID])
})

// I6, the other half: `resume()` does not sweep on its own however long the
// pause was. Every read declined while paused is in the store's re-read set,
// which the next cycle drains alongside the recency window; a sweep is for
// reaching files nothing has told us about, which is not what a pause produces.
it('does not sweep on resume, however long the pause was', async () => {
  await writeClaudeTranscript(transcriptPath(), ['the newest conversation'], SESSION_ID)
  await newIndexer({ recentPerAgent: 1 }).start()

  indexer?.pause()
  const older = transcriptPath(OTHER_SESSION_ID)
  await writeClaudeTranscript(older, ['an older conversation'], OTHER_SESSION_ID)
  const yesterday = new Date(clock.now() - 86_400_000)
  await utimes(older, yesterday, yesterday)
  clock.advance(10 * INTERVAL_MS)
  await indexer?.resume()

  expect(sessionsMatching('older')).toEqual([])
  // A sweep, asked for, is what reaches outside the recency window.
  await indexer?.reconcile({ full: true })
  expect(sessionsMatching('older')).toEqual([OTHER_SESSION_ID])
})

it('arms on resume when it was started while paused', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['indexed after the resume'], SESSION_ID)
  newIndexer()
  indexer?.pause()
  // Resolves without queueing a pass, rather than resolving as though one ran.
  await indexer?.start()
  expect(indexer?.status()).toMatchObject({ phase: 'paused', filesIndexed: 0 })

  await indexer?.resume()
  expect(sessionsMatching('resume')).toEqual([SESSION_ID])

  // The timer is armed too, so the interval after it reconciles as usual.
  await appendFile(path, `${claudeLines(['a later turn'], SESSION_ID, 10).join('\n')}\n`)
  await nextCycle()
  expect(sessionsMatching('later')).toEqual([SESSION_ID])
})

// C2: a root that comes back needs a sweep, because a cycle reads only the
// newest N per agent. One that flaps needs one sweep, not one a flap.
it('buys at most one sweep for a root that keeps flapping', async () => {
  const parked = join(harness.root, 'parked')
  const unmount = (): Promise<void> => rename(harness.claudeProjectDir, parked)
  const remount = (): Promise<void> => rename(parked, harness.claudeProjectDir)
  // A pass that swept planned a population; a cycle measures no population.
  const sweptThisPass = (): number => (indexer?.status().filesTotal === null ? 0 : 1)

  await writeClaudeTranscript(transcriptPath(), ['a session on a flapping mount'], SESSION_ID)
  await newIndexer().start()

  let sweeps = 0
  for (let round = 0; round < 3; round++) {
    await unmount()
    await nextCycle()
    sweeps += sweptThisPass()
    await remount()
    await nextCycle()
    sweeps += sweptThisPass()
  }
  expect(sweeps).toBe(1)
  // And nothing was retired on the way through: every empty pass had a
  // non-empty one behind it.
  expect(sessionsMatching('flapping')).toEqual([SESSION_ID])

  // The latch releases on a pass that finds the root healthy where the pass
  // before it did too, and the next recovery buys a sweep again.
  await nextCycle()
  await unmount()
  await nextCycle()
  await remount()
  await nextCycle()
  await nextCycle()
  expect(sweptThisPass()).toBe(1)
})

// A sweep used to watch every path it discovered, which made the next cycle
// walk the whole machine to learn that nothing had changed. What it could not
// settle is the only thing worth carrying.
it('watches what a sweep could not settle, not everything it discovered', async () => {
  const older = transcriptPath(OTHER_SESSION_ID)
  await writeClaudeTranscript(older, ['an older conversation'], OTHER_SESSION_ID)
  await writeClaudeTranscript(transcriptPath(), ['the newest conversation'], SESSION_ID)
  await newIndexer({ recentPerAgent: 1 }).start()

  await rm(older)
  await nextCycle()
  // Outside the recency window, so a cycle makes no promise about it.
  expect(sessionsMatching('older')).toEqual([OTHER_SESSION_ID])

  await indexer?.reconcile({ full: true })
  expect(sessionsMatching('older')).toEqual([])
})

// A progress pair has to be measured against the same population on both
// sides: the store holds rows a sweep's plan does not cover, so the unclamped
// pair reported more files indexed than there were files to index.
it('never reports more files indexed than the total behind them', async () => {
  const moved = transcriptPath()
  await writeClaudeTranscript(moved, ['a session in the old profile'], SESSION_ID)
  await newIndexer().start()
  indexer?.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()

  // The profile moves: the rows stay, and no root the sweep plans covers them.
  newIndexer({ roots: { ...harness.roots, claudeProjectsDir: join(harness.root, 'moved') } })
  await indexer?.start()
  const swept = indexer?.status()
  expect(swept?.filesIndexed).toBe(1)
  expect(swept?.filesTotal).toBeGreaterThanOrEqual(swept?.filesIndexed ?? 0)

  // A cycle measures the recency window, not a population, so it reports none.
  await nextCycle()
  expect(indexer?.status().filesTotal).toBeNull()
})

// F1: `fullSweepDue` stayed set across the sweep's await and was cleared on the
// way out, so a request raised while a sweep was running was erased by the
// sweep it arrived during. The pass takes the flag on entry now, and an
// unfinished sweep is what puts it back.
it('indexes a transcript the history window widened in during a sweep', async () => {
  for (let index = 0; index < 20; index++) {
    const session = `0000${String(index).padStart(4, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(transcriptPath(session), [`recent session ${index}`], session)
  }
  const old = transcriptPath(OTHER_SESSION_ID)
  await writeClaudeTranscript(old, ['an ancient conversation'], OTHER_SESSION_ID)
  // Dated on the clock the retention window is measured against, so 30 days
  // really does exclude it.
  const longAgo = new Date(clock.now() - 120 * 86_400_000)
  await utimes(old, longAgo, longAgo)

  let paced = 0
  newIndexer({
    historyDays: 30,
    // Widen part way through the sweep, which is when a user flips the setting.
    pace: async () => {
      if (paced++ === 0) {
        void indexer?.setHistoryDays(null)
      }
    }
  })
  await indexer?.start()
  await indexer?.settled()

  expect(sessionsMatching('ancient')).toEqual([OTHER_SESSION_ID])
})

it('runs another sweep when one is asked for during a sweep', async () => {
  for (let index = 0; index < 20; index++) {
    const session = `0000${String(index).padStart(4, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(transcriptPath(session), [`recent session ${index}`], session)
  }
  const late = transcriptPath(OTHER_SESSION_ID)

  let paced = 0
  // Newest-one per root, so nothing but a second sweep can reach the file that
  // appears after this sweep's discovery has already run.
  newIndexer({
    recentPerAgent: 1,
    pace: async () => {
      if (paced++ > 0) {
        return
      }
      await writeClaudeTranscript(late, ['a late conversation'], OTHER_SESSION_ID)
      const backdated = new Date(Date.now() - 86_400_000)
      await utimes(late, backdated, backdated)
      void indexer?.reconcile({ full: true })
    }
  })
  await indexer?.start()
  await indexer?.settled()

  expect(sessionsMatching('late')).toEqual([OTHER_SESSION_ID])
})

// F4: the allowance counts files and bytes, and the pacer sleeps for up to 15 s
// a batch on a loaded host, so a pass that never came near its byte budget
// could hold the loop for a quarter of an hour. Since the backfill drains
// inside the reconcile cycle, that is the recency promise gone.
it('hands the rest of a pass back when it runs out of wall time', async () => {
  for (let index = 0; index < 20; index++) {
    const session = `0000${String(index).padStart(4, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(transcriptPath(session), [`paced session ${index}`], session)
  }
  // Half an interval per pacing point, which is what a loaded host's back-off
  // costs. Eight files a batch, so the third batch is over the line.
  await newIndexer({ pace: async () => clock.advance(INTERVAL_MS / 2) }).start()

  expect(indexer?.status()).toMatchObject({ filesIndexed: 16, filesPending: 4 })

  // And the pass after it picks up exactly what was handed back.
  await nextCycle()
  expect(indexer?.status()).toMatchObject({ filesIndexed: 20, filesPending: 0 })
})
