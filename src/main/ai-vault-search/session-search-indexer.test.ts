import { appendFile, chmod, mkdir, rm, stat, utimes } from 'node:fs/promises'
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

function transcriptPath(name = SESSION_ID): string {
  return join(harness.claudeProjectDir, `${name}.jsonl`)
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

  expect(reopened.status().filesIndexed).toBe(0)
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
  expect(indexer?.status()).toMatchObject({ filesPending: 0, droppedPending: 2 })
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
  for (let index = 0; index < 4; index++) {
    await writeClaudeTranscript(
      transcriptPath(`0000000${index}-bbbb-4ccc-8ddd-eeeeeeeeeeee`),
      [`budgeted session number ${index}`],
      `0000000${index}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    )
  }
  // Start with the index off so the first pass through the reconciler is the
  // one that has to fit four files into a two-file allowance.
  newIndexer({ budget: { files: 2, bytes: 64 * 1024 } })
  await indexer?.reconcile()
  expect(indexer?.status().filesIndexed).toBe(2)
  expect(indexer?.status().filesPending).toBe(2)

  await indexer?.reconcile()
  expect(indexer?.status().filesPending).toBe(0)
  expect(sessionsMatching('budgeted')).toHaveLength(4)
})

// First enablement inside a running app is the normal case, not an edge: the
// session list has been scanning since launch, so every transcript already has
// a cursor sitting at its current stat and the index has nothing at all.
it('fills an empty index over a warm session-list cache on the first reconcile', async () => {
  const path = transcriptPath()
  await writeClaudeTranscript(path, ['scanned before the index existed'], SESSION_ID)
  // An ordinary parse now reuses its cached fold and opens no file, so no
  // consumer is asked and there is nothing for a decline to record.
  await parseTranscript(path)

  newIndexer()
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
