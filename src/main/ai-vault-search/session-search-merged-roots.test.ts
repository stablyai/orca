import { chmod, rm } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeMessageGraphTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'

// OpenClaw is the one agent whose roots are alternates for a single install, so
// discovery reports them as ONE discovery whose rootDir is every path joined by
// the platform's path delimiter. That string is not a directory: readdir on it
// answers ENOENT, containment never matches a real file, and a scan issue
// recorded against a real root never compares equal to it. Everything that
// judges a root works on the constituent directories, taken from the same
// source table discovery reads, never by splitting the label -- a directory may
// legally contain the delimiter.

const CAN_DENY_READ = process.platform !== 'win32' && process.getuid?.() !== 0
const INTERVAL_MS = 20_000

let harness: SessionSearchIndexerHarness
let clock: FakeSessionSearchClock
let indexer: SessionSearchIndexer

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  clock = new FakeSessionSearchClock()
  harness = await openSessionSearchIndexerHarness('ss-merged-roots')
})

afterEach(async () => {
  indexer.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness.cleanup()
})

/** OpenClaw reads `<stateDir>/agents/**` and keeps only paths through `sessions`. */
function openclawTranscript(stateDir: string, name: string): string {
  return join(stateDir, 'agents', 'main', 'sessions', `${name}.jsonl`)
}

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

it.skipIf(!CAN_DENY_READ)('fences one merged root without taking its partner down', async () => {
  const current = harness.roots.openclawStateDir ?? ''
  const legacy = harness.roots.openclawLegacyStateDir ?? ''
  const mounted = openclawTranscript(current, 'mounted-session')
  const local = openclawTranscript(legacy, 'local-session')
  await writeMessageGraphTranscript(mounted, ['a conversation on the mounted volume'])
  await writeMessageGraphTranscript(local, ['a conversation on local disk'])

  indexer = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock,
    reconcileIntervalMs: INTERVAL_MS,
    pace: async () => undefined
  })
  await indexer.start()
  expect(sessionsMatching('conversation').sort()).toEqual(['local-session', 'mounted-session'])

  // One of the two roots goes away; the other is untouched.
  await chmod(join(current, 'agents'), 0o000)
  try {
    await indexer.reconcile({ full: true })

    const status = indexer.status()
    const degraded = status.degradedRoots.map((root) => root.root)
    // A real directory, not the joined string discovery reports.
    expect(degraded).toContain(join(current, 'agents'))
    expect(degraded.every((root) => !root.includes(delimiter))).toBe(true)
    // Unprovable, so the unreadable root keeps its rows.
    expect(sessionsMatching('mounted')).toEqual(['mounted-session'])
  } finally {
    await chmod(join(current, 'agents'), 0o755)
  }
})

it('retires from one merged root while its partner is healthy', async () => {
  const current = harness.roots.openclawStateDir ?? ''
  const legacy = harness.roots.openclawLegacyStateDir ?? ''
  const going = openclawTranscript(current, 'going-session')
  await writeMessageGraphTranscript(going, ['a conversation about to be deleted'])
  // A sibling in the same root, so deleting one leaves the root listing files
  // and therefore healthy: this is a deletion, not an unmount.
  await writeMessageGraphTranscript(openclawTranscript(current, 'sibling-session'), [
    'a conversation beside it'
  ])
  await writeMessageGraphTranscript(openclawTranscript(legacy, 'staying-session'), [
    'a conversation that stays'
  ])

  indexer = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock,
    reconcileIntervalMs: INTERVAL_MS,
    pace: async () => undefined
  })
  await indexer.start()
  expect(sessionsMatching('conversation').sort()).toEqual([
    'going-session',
    'sibling-session',
    'staying-session'
  ])

  // A genuine deletion inside a healthy root still retires normally.
  await rm(going)
  await indexer.reconcile({ full: true })

  expect(sessionsMatching('deleted')).toEqual([])
  expect(indexer.status().degradedRoots).toEqual([])
  expect(sessionsMatching('conversation').sort()).toEqual(['sibling-session', 'staying-session'])
})
