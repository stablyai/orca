import './session-search-worker.test-fixture'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Replace worker transport while exercising the real SQLite readers.
export const openCodeReadCalls: string[] = []
vi.mock(
  '../ai-vault/scanners/opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn',
  async () => {
    const list =
      await import('../ai-vault/scanners/opencode/sqlite/session-scanner-opencode-sqlite-list')
    const parse =
      await import('../ai-vault/scanners/opencode/sqlite/session-scanner-opencode-sqlite')
    const capture =
      await import('../ai-vault/scanners/opencode/sqlite/session-scanner-opencode-sqlite-capture')
    const own = await import('./session-search-opencode-index.test')
    const { listOpenCode2SqliteSessions } =
      await import('../ai-vault/scanners/opencode2/session-scanner-opencode2-sqlite-list')
    return {
      listOpenCode2SqliteSessionsViaWorker: listOpenCode2SqliteSessions,
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
  }
)
import { resetSessionParseCacheForTests } from '../ai-vault/parse-cache/session-parse-cache-store'
import { resetTranscriptConsumersForTests } from '../ai-vault/transcripts/session-transcript-consumers'
import {
  appendOpenCodeSqliteTurn,
  writeOpenCodeSqliteDatabase
} from '../ai-vault/scanners/opencode/sqlite/session-scanner-opencode-sqlite-fixture'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchEngine } from './session-search-engine'
import { SessionSearchIndexer } from './session-search-indexer'
import { openSessionSearchDatabase } from './session-search-schema'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'

const ANSWER = 'the quokkaTelemetry harness reindexes every shard'
const OTHER = 'a completely unrelated conversation about typography'
const TOOL_ONLY = 'zarquonium'
const TOOL_FILE = '/repo/app/src/telemetry/shard-reindex.ts'
const SESSION = 'ses_capture'
const SECOND_SESSION = 'ses_second'

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
  await indexer?.close()
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
              // OpenCode’s filePath spelling must normalize to the indexed file_path key.
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

it('excludes tool output from both search scopes', async () => {
  writeVault()
  await startIndexer()

  const all = openEngine().search({ query: TOOL_ONLY, scope: 'all' })
  expect(all.hits).toEqual([])
  expect(openEngine().search({ query: TOOL_ONLY, scope: 'conversation' }).hits).toEqual([])
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
  expect(engine.search({ query: ANSWER }).hits).toHaveLength(1)
  expect(openCodeReadCalls.filter((call) => call === `capture:${SESSION}`)).toHaveLength(2)
})
