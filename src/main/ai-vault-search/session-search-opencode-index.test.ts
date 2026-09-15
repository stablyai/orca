import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Only the thread hop is replaced: all three implementations below are the
// repo's own in-process readers, which the worker entry calls on the other side.
export const openCodeReadCalls: string[] = []
vi.mock('../ai-vault/session-scanner-opencode-sqlite-worker-spawn', async () => {
  const list = await import('../ai-vault/session-scanner-opencode-sqlite-list')
  const parse = await import('../ai-vault/session-scanner-opencode-sqlite')
  const capture = await import('../ai-vault/session-scanner-opencode-sqlite-capture')
  const own = await import('./session-search-opencode-index.test')
  return {
    resolveOpenCodeSqliteWorkerEntryPath: () => null,
    listOpenCodeSqliteSessionsViaWorker: (
      args: Parameters<typeof list.listOpenCodeSqliteSessions>[0]
    ) => list.listOpenCodeSqliteSessions(args),
    parseOpenCodeSqliteSessionViaWorker: (
      args: Parameters<typeof parse.parseOpenCodeSqliteSession>[0]
    ) => {
      own.openCodeReadCalls.push(`parse:${args.sessionId}`)
      return parse.parseOpenCodeSqliteSession(args)
    },
    captureOpenCodeSqliteSessionViaWorker: (
      args: Parameters<typeof capture.captureOpenCodeSqliteSession>[0]
    ) => {
      own.openCodeReadCalls.push(`capture:${args.sessionId}`)
      return capture.captureOpenCodeSqliteSession(args)
    }
  }
})
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import { buildOpenCodeSqliteCandidatePath } from '../ai-vault/session-scanner-opencode-sqlite-paths'
import {
  appendOpenCodeSqliteTurn,
  writeOpenCodeSqliteDatabase
} from '../ai-vault/session-scanner-opencode-sqlite-fixture'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchEngine } from './session-search-engine'
import { SessionSearchIndexer } from './session-search-indexer'
import { openSessionSearchDatabase } from './session-search-schema'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'

/*
 * Nothing any OpenCode agent said used to be searchable. Its sessions live in
 * one SQLite database read on a worker thread, and the worker only ever
 * returned the newest few messages for the panel preview, so the index recorded
 * a placeholder row and moved on. This is the end-to-end proof that a sentence
 * an OpenCode assistant wrote comes back from a real search over a real index.
 */

// Literal-looking on purpose: the `phrase` route is the one a user quoting a
// remembered sentence takes, and only a literal query reaches it.
const ANSWER = 'the quokkaTelemetry harness reindexes every shard'
const OTHER = 'a completely unrelated conversation about typography'
// Appears only in a tool part's output, so it separates the two scopes.
const TOOL_ONLY = 'zarquonium'
const TOOL_FILE = '/repo/app/src/telemetry/shard-reindex.ts'
const SESSION = 'ses_capture'
const SECOND_SESSION = 'ses_second'
const CLAUDE_SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

let harness: SessionSearchIndexerHarness
let clock: FakeSessionSearchClock
let indexer: SessionSearchIndexer | null = null
let engineDbs: SyncDatabase[] = []

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  clock = new FakeSessionSearchClock()
  harness = await openSessionSearchIndexerHarness('ss-opencode-index')
  indexer = null
  engineDbs = []
  openCodeReadCalls.length = 0
})

afterEach(async () => {
  indexer?.close()
  for (const db of engineDbs) {
    db.close()
  }
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness.cleanup()
})

function dbPath(): string {
  return join(harness.root, 'opencode-db', 'opencode.db')
}

async function startIndexer(): Promise<SessionSearchIndexer> {
  const started = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: { ...harness.roots, opencodeDbPaths: [dbPath()] },
    historyDays: null,
    clock,
    reconcileIntervalMs: 20_000,
    onError: (error) => {
      throw error
    }
  })
  indexer = started
  await started.start()
  return started
}

/** A second connection on the index file, the way the live instance pairs them. */
function openEngine(): SessionSearchEngine {
  const db = openSessionSearchDatabase(harness.databasePath)
  engineDbs.push(db)
  return new SessionSearchEngine(db)
}

function writeVault(): void {
  writeOpenCodeSqliteDatabase(dbPath(), [
    {
      id: SESSION,
      title: 'Telemetry work',
      directory: '/tmp/opencode',
      turns: [
        { role: 'user', parts: ['how do I reindex the shards'] },
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'Checking how the shard map is built.' },
            'Here is the plan.',
            ANSWER,
            {
              type: 'tool',
              tool: 'read',
              // The camelCase spelling OpenCode writes; the shared key list
              // knows only `file_path`, so finding this proves the rename.
              input: { filePath: TOOL_FILE },
              output: `export const marker = '${TOOL_ONLY}'`
            },
            {
              type: 'tool',
              tool: 'bash',
              input: { command: 'pnpm reindex --all' },
              error: 'reindex exited with code 2'
            }
          ]
        }
      ]
    },
    {
      id: SECOND_SESSION,
      title: 'Typography',
      directory: '/tmp/opencode-two',
      turns: [{ role: 'assistant', parts: [OTHER] }]
    }
  ])
}

it('finds a sentence an OpenCode assistant wrote, through the real indexer', async () => {
  writeVault()
  await startIndexer()

  const response = openEngine().search({ query: ANSWER })

  expect(response.planner.route).toBe('phrase')
  expect(response.hits).toHaveLength(1)
  const hit = response.hits[0]
  expect(hit).toMatchObject({
    agent: 'opencode',
    sessionId: SESSION,
    cwd: '/tmp/opencode'
  })
  expect(hit?.evidence?.role).toBe('assistant')
  expect(hit?.evidence?.snippet).toContain('quokkaTelemetry')
  // The whole-session read, not the preview window: the user turn is indexed too.
  expect(openEngine().search({ query: 'reindex the shards' }).hits).toHaveLength(1)
  // And the sibling session is a session of its own, not folded into this one.
  expect(openEngine().search({ query: OTHER }).hits[0]?.sessionId).toBe(SECOND_SESSION)
})

it('searches tool output under the all scope and not under conversation', async () => {
  writeVault()
  await startIndexer()

  const all = openEngine().search({ query: TOOL_ONLY, scope: 'all' })
  expect(all.hits).toHaveLength(1)
  expect(all.hits[0]).toMatchObject({ agent: 'opencode', sessionId: SESSION })
  expect(all.hits[0]?.evidence?.role).toBe('tool')
  // Conversation is user and assistant turns only, so a token that lives in a
  // tool's output has nothing to match there.
  expect(openEngine().search({ query: TOOL_ONLY, scope: 'conversation' }).hits).toEqual([])
})

it('indexes a tool call by its file argument and a failed one by its error', async () => {
  writeVault()
  await startIndexer()

  // `filePath` renamed to the spelling the shared input-key list knows: without
  // it the call line would be the bare tool name and this would find nothing.
  expect(openEngine().search({ query: TOOL_FILE, scope: 'all' }).hits[0]?.sessionId).toBe(SESSION)
  // A call that failed carries its error where a completed one carries output.
  const failed = openEngine().search({ query: 'reindex exited with code', scope: 'all' })
  expect(failed.hits[0]?.evidence?.role).toBe('tool')
})

it('folds a reasoning part into the assistant turn it belongs to', async () => {
  writeVault()
  await startIndexer()

  const hit = openEngine().search({ query: 'checking how the shard map is built' }).hits[0]
  expect(hit?.sessionId).toBe(SESSION)
  expect(hit?.evidence?.role).toBe('assistant')
})

it('reads an OpenCode session once, not on every pass', async () => {
  writeVault()
  const claudePath = join(harness.claudeProjectDir, 'control.jsonl')
  await writeClaudeTranscript(claudePath, ['control turn'], CLAUDE_SESSION)
  const started = await startIndexer()

  await started.reconcile()
  await started.reconcile()

  // One capture per session across three passes; nothing re-decodes a session
  // whose `time_updated` has not moved.
  expect(openCodeReadCalls).toEqual([`capture:${SESSION}`, `capture:${SECOND_SESSION}`])
  const rows = harness.read((db) =>
    db.prepare('SELECT path, state, session_row_id FROM files ORDER BY path').all()
  ) as { path: string; state: string; session_row_id: number | null }[]
  expect(
    rows.find((row) => row.path === buildOpenCodeSqliteCandidatePath(dbPath(), SESSION))
  ).toMatchObject({ state: 'current' })
  expect(
    rows.find((row) => row.path === buildOpenCodeSqliteCandidatePath(dbPath(), SESSION))
      ?.session_row_id
  ).not.toBeNull()
  expect(started.status()).toMatchObject({ filesDue: 0, filesFailed: 0, phase: 'current' })
  // The count that made this bug visible: two OpenCode files, two OpenCode
  // sessions. Before the capture channel it read two files and zero sessions.
  expect(started.status().sessionsByAgent).toMatchObject({ opencode: 2, claude: 1 })
})

it('re-reads a session that gained a message and replaces its rows', async () => {
  writeVault()
  const started = await startIndexer()
  expect(openEngine().search({ query: 'orthogonal vestibule' }).hits).toHaveLength(0)

  appendOpenCodeSqliteTurn(dbPath(), SESSION, {
    role: 'assistant',
    parts: ['an orthogonal vestibule appeared']
  })
  await started.reconcile()

  const engine = openEngine()
  expect(engine.search({ query: 'orthogonal vestibule' }).hits[0]?.sessionId).toBe(SESSION)
  // Replaced whole, not appended twice: the original turn is still one hit.
  expect(engine.search({ query: ANSWER }).hits).toHaveLength(1)
  expect(openCodeReadCalls.filter((call) => call === `capture:${SESSION}`)).toHaveLength(2)
})
