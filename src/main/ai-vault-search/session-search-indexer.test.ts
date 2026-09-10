import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
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

/** The byte offset the index recorded; PR 2 stores -1 for a half-written file. */
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

/** What a chunk of a read that never finished leaves on the file row. */
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

/**
 * Makes every pass stop after `files` reads: the pass consults the clock once
 * per file it is about to read, and each reading costs a quarter of the
 * deadline it is measured against.
 */
function readsPerPass(files: number): { passDeadlineMs: number } {
  clock.costPerNowMs = 1_000
  return { passDeadlineMs: files * 1_000 }
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
    db.prepare('SELECT count(*) AS n FROM messages').get()
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
    harness.read((db: SyncDatabase) => db.prepare('SELECT count(*) AS n FROM messages').get())
  ).toEqual(indexedRows)
  expect(sessionsMatching('indexed')).toEqual([SESSION_ID, OTHER_SESSION_ID].sort())
})

// F12, as the immutable design states it: the history window is a construction
// argument, so widening it is a new instance whose opening sweep admits the
// older files, and narrowing it is the purge that opens every full sweep.
it('widens history by constructing a new instance and narrows by purging on its first sweep', async () => {
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
      // A degraded root is not a degraded index: everything else still lands.
      expect(sessionsMatching('readable')).toEqual([SESSION_ID])
    } finally {
      await chmod(harness.roots.codexSessionsDir ?? '', 0o755)
    }
  }
)

// The one bound on a pass: what it does not reach goes back on the queue, and
// the pass after it picks up exactly that. A file handed back and then unchanged
// still has to settle -- the re-read is whole, so it writes an identical cursor,
// and judging that by cursor movement would owe the file for ever.
it('reads what one pass has time for and finishes the rest on the next', async () => {
  // The sweep is behind us, so this is the reconciler fitting four new files
  // into a deadline that stops it after two.
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
  expect(indexer?.status()).toMatchObject({ filesIndexed: 3, filesPending: 2 })

  await indexer?.reconcile()
  expect(indexer?.status().filesPending).toBe(0)
  expect(sessionsMatching('deadlined')).toHaveLength(4)

  // Settled, and it stays settled: nothing changed, so the cycle after this
  // one opens none of them, and reports reading nothing.
  clock.costPerNowMs = 0
  await nextCycle()
  expect(indexer?.status()).toMatchObject({ filesPending: 0, bytesIndexed: 0 })
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

// Finding 1: a sweep cut short used to be abandoned part way through. A pass
// that hands reads back is not an unfinished sweep -- its discovery and its
// retirement both completed -- so it must not re-arm one, and the queue is what
// carries the reads it did not reach until the whole machine is covered.
it('covers the whole machine over the passes that follow a truncated sweep', async () => {
  const sessions = Array.from(
    { length: 20 },
    (_unused, index) => `0000${String(index).padStart(4, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
  )
  for (const session of sessions) {
    await writeClaudeTranscript(transcriptPath(session), [`sweepwide session ${session}`], session)
  }

  // One transcript a pass, so the opening sweep reaches a twentieth of them.
  await newIndexer(readsPerPass(1)).start()
  expect(indexedSessionCount()).toBeGreaterThan(0)
  expect(indexedSessionCount()).toBeLessThan(sessions.length)

  for (let cycle = 0; cycle < sessions.length; cycle++) {
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

// Finding 4d: a declined read returns without throwing, and counting it as
// indexed is how a status claims files the index does not hold.
it('counts a file as indexed only when the index actually took it', async () => {
  await writeClaudeTranscript(transcriptPath(), ['a real read'], SESSION_ID)
  await newIndexer().start()
  const afterSweep = indexer?.status().bytesIndexed ?? 0
  expect(afterSweep).toBeGreaterThan(0)

  // Nothing changed, so the next cycle reads nothing and must claim nothing.
  // `bytesIndexed` is what the pass that just ran read, so it is zero here.
  await indexer?.reconcile()
  expect(indexer?.status()).toMatchObject({ filesIndexed: 1, bytesIndexed: 0 })
})

// Round 10, H1. A cycle proves a deletion by comparing what the previous pass
// watched against what it discovers. A sweep used to watch only what it could
// not settle, which is nothing on a healthy machine, so the cycle after a sweep
// had no candidates at all and the cycle after that no longer remembered the
// file: a transcript deleted in that interval survived until the next sweep,
// up to `fullSweepEveryCycles` later.
it('retires a transcript deleted between a sweep and the cycle after it', async () => {
  const going = transcriptPath()
  const staying = transcriptPath(OTHER_SESSION_ID)
  await writeClaudeTranscript(going, ['a session deleted right after the sweep'], SESSION_ID)
  await writeClaudeTranscript(staying, ['a surviving session'], OTHER_SESSION_ID)
  await newIndexer().start()
  expect(sessionsMatching('deleted')).toEqual([SESSION_ID])

  // No cycle in between: the sweep is the only pass that has seen this file.
  await rm(going)
  await nextCycle()

  expect(sessionsMatching('deleted')).toEqual([])
  expect(sessionsMatching('surviving')).toEqual([OTHER_SESSION_ID])
})

// Round 10, M1. A transcript the reader cannot open is recorded stale by the
// consumer on every attempt, so it was re-read every cycle for ever: pending
// stuck at one, a failure count climbing without bound, and a phase that never
// left `indexing`. One file with the wrong mode bits read as a real backlog.
it.skipIf(!CAN_DENY_READ)('stops re-reading a transcript it cannot read', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['a session behind the wrong mode bits'], SESSION_ID)
  await chmod(path, 0o000)
  try {
    await newIndexer().start()
    for (let cycle = 0; cycle < 4; cycle++) {
      await nextCycle()
    }

    // Held out, not queued: the queue is empty, the count is a gauge of files
    // being held rather than a tally of attempts, and the phase says the index
    // knows it is not covering something.
    expect(indexer?.status()).toMatchObject({
      filesPending: 0,
      unreadableFiles: 1,
      phase: 'degraded'
    })

    // And the hold is released by the only thing that can mean the file
    // changed: its stat.
    await chmod(path, 0o644)
    const later = new Date(Date.now() + 60_000)
    await utimes(path, later, later)
    await nextCycle()

    expect(sessionsMatching('mode')).toEqual([SESSION_ID])
    expect(indexer?.status()).toMatchObject({ unreadableFiles: 0, phase: 'current' })
  } finally {
    await chmod(path, 0o644)
  }
})

// Round 10, M2. `close()` mid-pass left the pass reading a shut handle: three
// `database is not open` errors reached the owner, for a close they asked for.
it('reports nothing to its owner when it is closed part way through a pass', async () => {
  await writeClaudeTranscript(transcriptPath(), ['one'], SESSION_ID)
  const other = transcriptPath(OTHER_SESSION_ID)
  await writeClaudeTranscript(other, ['two'], OTHER_SESSION_ID)
  const later = new Date(Date.now() + 60_000)
  await utimes(other, later, later)
  newIndexer()

  // Between two files: the pass reads the clock once per file it is about to
  // read, and closing there is what a quit during a sweep looks like.
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

// Round 10, M2, the other half: `status()` on a closed indexer opened a shut
// database, reported the failure, and answered zero files.
it('reports what it last knew after it is closed, without reading the database', async () => {
  await writeClaudeTranscript(transcriptPath(), ['indexed before the close'], SESSION_ID)
  await newIndexer().start()
  expect(indexer?.status().filesIndexed).toBe(1)

  indexer?.close()

  expect(indexer?.status()).toMatchObject({ phase: 'closed', filesIndexed: 1 })
  expect(errors).toEqual([])
})

// Round 10, L1. Two indexers on one database both register with the reader, so
// every transcript is read and written twice and the second write is fenced by
// the first at random. The recipe for every configuration change is
// close-then-construct, so the ordering that causes this is the one the recipe
// rules out; this is what says so rather than letting it corrupt quietly.
it('refuses a second indexer on a database one already owns', () => {
  newIndexer()
  expect(() => newIndexer()).toThrow(/already has a live indexer/)
})

// PR 2 records a cursor no append continues for a file a chunked read left half
// written, and reports it as a null offset. The mtime and size on that row are
// the whole file's, so a freshness check comparing only those calls a prefix
// current and leaves it in the index for good.
it('re-reads a file a chunked read left half written, and settles it in one pass', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['the committed half'], SESSION_ID)
  await newIndexer().start()
  const whole = (await stat(path)).size
  expect(indexedByteOffset(path)).toBe(whole)
  indexer?.close()

  plantPartialCursor(path)
  await newIndexer().start()

  // Nothing about the file changed, and it was read anyway: the whole of it,
  // because there is no cursor to continue from.
  expect(indexer?.status().bytesIndexed).toBe(whole)
  expect(indexedByteOffset(path)).toBe(whole)
  expect(indexer?.status().phase).toBe('current')
  indexer?.close()

  // A half-written file that also grew is repaired by one pass rather than two.
  // The session list's resume point would have the reader offer an append here,
  // and an append onto a partial cursor is a read the consumer declines.
  plantPartialCursor(path)
  await appendFile(path, `${claudeLines(['the lost half'], SESSION_ID, 10).join('\n')}\n`)
  await newIndexer().start()

  expect(sessionsMatching('lost')).toEqual([SESSION_ID])
  expect(indexer?.status()).toMatchObject({ filesPending: 0, phase: 'current' })
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
  // One file a pass, so the older one is queued carrying this stat.
  await startAfterASweep(readsPerPass(1))
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
it('reads a declined file at its current stat, not the one it was recorded with', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['the recorded conversation'], SESSION_ID)
  await newIndexer().start()

  // A warm session-list cache over an empty index: the reader offers an append
  // continuing an offset this index has never seen, so the consumer declines it
  // and records the stat it declined at.
  indexer?.close()
  removeSessionSearchDatabase(harness.databasePath)
  newIndexer()
  await appendFile(path, `${claudeLines(['declined turn'], SESSION_ID, 10).join('\n')}\n`)
  await parseTranscript(path)
  expect(indexer?.status().filesPending).toBe(1)

  await appendFile(path, `${claudeLines(['later turn'], SESSION_ID, 20).join('\n')}\n`)
  // The sweep is declined too -- the list's cursor is still ahead of the index
  // -- so it is the cycle draining the queue that reads the file whole.
  await indexer?.start()
  await nextCycle()

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

// A cycle only reads the newest N per agent, so a remounted volume would give
// up its newest transcript and keep the rest unreachable. Nothing watches for a
// recovery any more: the sweep cadence is what reaches it.
it('reads a root that came back on the next periodic sweep', async () => {
  // Detached before anything was ever indexed, so the sweep correctly finds
  // nothing and reports no alarm.
  await newIndexer({ recentPerAgent: 1, fullSweepEveryCycles: 2 }).start()
  expect(indexer?.status()).toMatchObject({ degradedRoots: [], filesIndexed: 0 })

  for (let index = 0; index < 3; index++) {
    const session = `0000000${index}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(transcriptPath(session), [`remounted session ${index}`], session)
  }

  // Two cycles reach the newest one each; the sweep they are counting down to
  // reads the rest.
  await nextCycle()
  await nextCycle()
  expect(sessionsMatching('remounted')).toHaveLength(1)

  await nextCycle()
  expect(sessionsMatching('remounted')).toHaveLength(3)
})

// Round 4, item 3: rows under no configured root. The walk judges each row on
// its own directory and proves nothing about one it cannot reach, so a profile
// that moved keeps its history rather than losing it.
it('keeps rows under no configured root, and retires them only when gone', async () => {
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
  // Still on disk, so the rows stay: this is a configuration problem, not a
  // licence to delete a user's history.
  expect(sessionsMatching('profile')).toEqual([SESSION_ID])

  await rm(moved)
  await indexer?.reconcile({ full: true })
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

// C1: `close()` disarmed the timer and aborted the task in flight, but left the
// queue running, so a task queued a moment earlier still reopened a store and
// registered a consumer behind an indexer whose caller had finished with it.
it('stops everything on close, including work already queued', async () => {
  await writeClaudeTranscript(transcriptPath(), ['indexed before the close'], SESSION_ID)
  await newIndexer().start()

  const queued = indexer?.reconcile({ full: true })
  indexer?.close()
  await queued

  // The queued pass never ran: had it run, it would have reached for a store
  // this close had already shut, and reported the failure.
  expect(errors).toEqual([])
  // And the timer is gone with it, so no later tick can queue another.
  expect(clock.pendingTimers).toBe(0)
  clock.advance(5 * INTERVAL_MS)
  await indexer?.settled()
  expect(errors).toEqual([])

  // No store and no consumer: a scan after the close writes nothing.
  const after = transcriptPath(OTHER_SESSION_ID)
  await writeClaudeTranscript(after, ['written after the close'], OTHER_SESSION_ID)
  await parseTranscript(after)
  expect(sessionsMatching('written')).toEqual([])
  expect(sessionsMatching('indexed')).toEqual([SESSION_ID])
})

// What replaced `clear()`, exactly as the PR body documents it. The recipe is
// three statements because the indexer owns one store for one lifetime; the
// method it replaces owned a second one and had to keep the two in step.
it('throws the index away and rebuilds it by constructing a new instance', async () => {
  await writeClaudeTranscript(transcriptPath(), ['indexed before the clear'], SESSION_ID)
  await newIndexer().start()
  expect(existsSync(harness.databasePath)).toBe(true)

  indexer?.close()
  removeSessionSearchDatabase(harness.databasePath)
  expect(existsSync(harness.databasePath)).toBe(false)

  // The session list's cache is warm, which is what a clear inside a running
  // app leaves behind; the sweep reads whole rather than trusting it.
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

// I7: the sweep reads transcript bytes, so it stops at the same deadline every
// other pass does. It plans the whole machine and hands back what it had no
// time for; the passes that follow drain the plan without re-discovering.
it('stops the opening sweep at its deadline and drains the rest over the passes that follow', async () => {
  for (let index = 0; index < 5; index++) {
    const session = `0000000${index}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(transcriptPath(session), [`backlogged session ${index}`], session)
  }
  await newIndexer(readsPerPass(2)).start()
  expect(indexer?.status()).toMatchObject({ filesIndexed: 2, filesPending: 3 })

  await nextCycle()
  expect(indexer?.status()).toMatchObject({ filesIndexed: 4, filesPending: 1 })

  await nextCycle()
  expect(sessionsMatching('backlogged')).toHaveLength(5)
  expect(indexer?.status()).toMatchObject({ filesPending: 0, phase: 'current' })
})

// The sweep cadence, with nobody asking for it: a file outside the recency
// window that appears after the opening sweep is unreachable until the next
// periodic one, and the count of cycles is the whole rule.
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

// F1: `fullSweepDue` stayed set across the sweep's await and was cleared on the
// way out, so a request raised while a sweep was running was erased by the
// sweep it arrived during. The pass takes the flag on entry now, and an
// unfinished sweep is what puts it back.
it('runs another sweep when one is asked for during a sweep', async () => {
  for (let index = 0; index < 20; index++) {
    const session = `0000${String(index).padStart(4, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(transcriptPath(session), [`recent session ${index}`], session)
  }
  const late = transcriptPath(OTHER_SESSION_ID)

  // Newest-one per root, so nothing but a second sweep can reach a file that
  // appears after this sweep's discovery has already run. The clock is the one
  // synchronous seam into a pass: it is read between files.
  newIndexer({ recentPerAgent: 1 })
  let armed = false
  // Once a row has landed the pass is provably inside its read loop, which is
  // after it took the sweep flag and before it hands its verdicts back.
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

// The duty cycle, as a test: a pass reads for at most its deadline and hands
// the rest back, and the timer only re-arms once the pass has settled, so the
// share of the wall clock the index takes is bounded by construction.
it('hands the rest of a pass back when it runs out of wall time', async () => {
  for (let index = 0; index < 20; index++) {
    const session = `0000${String(index).padStart(4, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    await writeClaudeTranscript(transcriptPath(session), [`deadlined session ${index}`], session)
  }
  await newIndexer(readsPerPass(16)).start()

  expect(indexer?.status()).toMatchObject({ filesIndexed: 16, filesPending: 4 })

  // And the pass after it picks up exactly what was handed back.
  await nextCycle()
  expect(indexer?.status()).toMatchObject({ filesIndexed: 20, filesPending: 0 })
})
