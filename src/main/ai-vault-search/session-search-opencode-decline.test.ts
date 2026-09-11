import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Only the thread hop is replaced: both implementations below are the repo's
// own in-process readers, which the worker entry calls on the other side.
export const openCodeParseCalls: string[] = []
vi.mock('../ai-vault/session-scanner-opencode-sqlite-worker-spawn', async () => {
  const list = await import('../ai-vault/session-scanner-opencode-sqlite-list')
  const parse = await import('../ai-vault/session-scanner-opencode-sqlite')
  const own = await import('./session-search-opencode-decline.test')
  return {
    resolveOpenCodeSqliteWorkerEntryPath: () => null,
    listOpenCodeSqliteSessionsViaWorker: (
      args: Parameters<typeof list.listOpenCodeSqliteSessions>[0]
    ) => list.listOpenCodeSqliteSessions(args),
    parseOpenCodeSqliteSessionViaWorker: (
      args: Parameters<typeof parse.parseOpenCodeSqliteSession>[0]
    ) => {
      own.openCodeParseCalls.push(args.sessionId)
      return parse.parseOpenCodeSqliteSession(args)
    }
  }
})
import Database from '../sqlite/sync-database'
import { getSessionParseCacheEntry } from '../ai-vault/session-parse-cache-store'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import { buildOpenCodeSqliteCandidatePath } from '../ai-vault/session-scanner-opencode-sqlite-paths'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'

/*
 * Round 12, F3. An OpenCode SQLite session decodes where the message channel
 * cannot reach it, so no read of one will ever commit a row. The consumer
 * declined it and wrote nothing, which left the file table silent about a
 * source discovery returns on every pass: the decide step saw a path the index
 * held nothing for, asked for a read, and asking for one over a warm cache
 * drops the session list's own resume point. Every OpenCode session was fully
 * decoded on every pass and the sidebar's fold was thrown away with it, which
 * is the cache STA-1278 and STA-1417 added.
 */

const SESSION = 'ses_r12'
const CLAUDE_SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

let harness: SessionSearchIndexerHarness
let clock: FakeSessionSearchClock
let indexer: SessionSearchIndexer | null = null

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  clock = new FakeSessionSearchClock()
  harness = await openSessionSearchIndexerHarness('ss-opencode-decline')
  indexer = null
  openCodeParseCalls.length = 0
})

afterEach(async () => {
  indexer?.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness.cleanup()
})

function writeOpenCodeDb(path: string, sessionId: string): void {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
      directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
      summary_diffs TEXT, revert TEXT, permission TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_compacting INTEGER,
      time_archived INTEGER, workspace_id TEXT, path TEXT, agent TEXT, model TEXT,
      cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      metadata TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE project (
      id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT,
      icon_color TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      time_initialized INTEGER, sandboxes TEXT NOT NULL, commands TEXT, icon_url_override TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
  `)
  db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version,
       time_created, time_updated, agent, model, cost, tokens_input, tokens_output,
       tokens_reasoning, tokens_cache_read, tokens_cache_write)
     VALUES (?, 'proj-1', NULL, 'slug-1', '/tmp/opencode', 'OpenCode title', '1.0.0',
       ?, ?, 'build', '{"id":"glm"}', 0, 1, 1, 0, 0, 0)`
  ).run(sessionId, 1_740_000_000_000, 1_740_000_100_000)
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`
  ).run(
    'msg-1',
    sessionId,
    1_740_000_000_000,
    1_740_000_000_000,
    JSON.stringify({ role: 'user', time: { created: 1_740_000_000_000 } })
  )
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    'part-1',
    'msg-1',
    sessionId,
    1_740_000_000_000,
    1_740_000_000_000,
    JSON.stringify({ type: 'text', text: 'hello opencode' })
  )
  db.prepare(
    `INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
     VALUES ('proj-1', '/tmp/opencode', 'proj', ?, ?, '[]')`
  ).run(1_740_000_000_000, 1_740_000_000_000)
  db.close()
}

it('reads an OpenCode session once, not on every pass', async () => {
  const dbPath = join(harness.root, 'opencode-db', 'opencode.db')
  mkdirSync(join(harness.root, 'opencode-db'), { recursive: true })
  writeOpenCodeDb(dbPath, SESSION)
  const claudePath = join(harness.claudeProjectDir, 'control.jsonl')
  await writeClaudeTranscript(claudePath, ['control turn'], CLAUDE_SESSION)

  indexer = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: { ...harness.roots, opencodeDbPaths: [dbPath] },
    historyDays: null,
    clock,
    reconcileIntervalMs: 20_000,
    onError: () => undefined
  })
  await indexer.start()

  const syntheticPath = buildOpenCodeSqliteCandidatePath(dbPath, SESSION)
  const openCodeAfterFirst = getSessionParseCacheEntry(syntheticPath)
  const claudeAfterFirst = getSessionParseCacheEntry(claudePath)

  await indexer.reconcile()
  await indexer.reconcile()

  // One decode across three passes, and the session list's cached fold for it
  // is the same object it was after the first: nothing invalidated it.
  expect(openCodeParseCalls).toHaveLength(1)
  expect(getSessionParseCacheEntry(syntheticPath)).toBe(openCodeAfterFirst)
  // The control, which the index really does hold, is untouched either way.
  expect(getSessionParseCacheEntry(claudePath)).toBe(claudeAfterFirst)

  // What makes it skippable: a row saying the index has seen this source and
  // holds no session for it, which is the shape a read-through-with-no-session
  // already leaves.
  const rows = harness.read((db) =>
    db.prepare('SELECT path, state, session_row_id FROM files ORDER BY path').all()
  ) as { path: string; state: string; session_row_id: number | null }[]
  expect(rows).toHaveLength(2)
  expect(rows.find((row) => row.path === syntheticPath)).toMatchObject({
    state: 'current',
    session_row_id: null
  })
  expect(indexer.status()).toMatchObject({ filesDue: 0, filesFailed: 0, phase: 'current' })
})
