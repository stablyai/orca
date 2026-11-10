import './session-search-worker.test-fixture'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Replace worker transport while exercising the real SQLite readers.
export const openCodeReadCalls: string[] = []
export const openCodeListObservations: { paths: readonly string[]; limit: number; rows: number }[] =
  []
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
    const parse2 = await import('../ai-vault/scanners/opencode2/session-scanner-opencode2-sqlite')
    return {
      parseOpenCode2SqliteSessionViaWorker: parse2.parseOpenCode2SqliteSession,
      captureOpenCode2SqliteSessionViaWorker: parse2.captureOpenCode2SqliteSession,
      listOpenCode2SqliteSessionsViaWorker: listOpenCode2SqliteSessions,
      resolveOpenCodeSqliteWorkerEntryPath: () => null,
      listOpenCodeSqliteSessionsViaWorker: (
        args: Parameters<typeof list.listOpenCodeSqliteSessions>[0]
      ) =>
        list.listOpenCodeSqliteSessions(args).then((candidates) => {
          own.openCodeListObservations.push({
            paths: args.dbPaths,
            limit: args.limit,
            rows: candidates.length
          })
          return candidates
        }),
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
import SyncDatabase from '../sqlite/sync-database'
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
  openCodeListObservations.length = 0
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

it.each([40, 400])(
  'keeps recent database observations bounded at %s rows while old imports reach search on maintenance',
  async (population) => {
    writeOpenCodeSqliteDatabase(
      dbPath(),
      Array.from({ length: population }, (_, index) => ({
        id: `ses_${index}`,
        turns: [{ role: 'user', parts: ['retainedarchive'] }]
      }))
    )
    const subject = await startIndexer()
    appendOpenCodeSqliteTurn(dbPath(), 'ses_0', {
      role: 'assistant',
      parts: ['recentdatabaseneedle']
    })
    clock.advance(20000)
    await subject.settled()
    expect(openEngine().search({ query: 'recentdatabaseneedle' }).hits[0]?.sessionId).toBe('ses_0')
    expect(openCodeListObservations.at(-1)).toMatchObject({ limit: 12, rows: 12 })
    writeOpenCodeSqliteDatabase(dbPath(), [
      { id: 'ses_imported', turns: [{ role: 'user', parts: ['oldimportneedle'] }] }
    ])
    const source = new SyncDatabase(dbPath())
    source
      .prepare("UPDATE session SET time_created=1000, time_updated=2000 WHERE id='ses_imported'")
      .run()
    source.close()
    for (let cycle = 0; cycle < 14; cycle++) {
      clock.advance(20000)
      await subject.settled()
    }
    expect(
      openCodeListObservations.filter((observation) => observation.limit === Infinity)
    ).toHaveLength(2)
    expect(
      openCodeListObservations
        .filter((observation) => observation.limit === 12)
        .every((observation) => observation.rows === 12)
    ).toBe(true)
    expect(openEngine().search({ query: 'oldimportneedle' }).hits[0]?.sessionId).toBe(
      'ses_imported'
    )
  }
)

it('keeps a duplicate physical row and promotes it when the selected database disappears', async () => {
  const alternative = join(harness.root, 'opencode-db', 'opencode-alternative.db')
  writeOpenCodeSqliteDatabase(dbPath(), [
    { id: 'ses_shared', turns: [{ role: 'user', parts: ['winningcopyneedle'] }] },
    { id: 'ses_primary', turns: [{ role: 'user', parts: ['primaryonlyneedle'] }] }
  ])
  writeOpenCodeSqliteDatabase(alternative, [
    { id: 'ses_shared', turns: [{ role: 'user', parts: ['alternativecopyneedle'] }] },
    { id: 'ses_alternative', turns: [{ role: 'user', parts: ['alternativeonlyneedle'] }] }
  ])
  let paths = [dbPath(), alternative]
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: { ...harness.roots, opencodeDbPaths: paths },
    resolveRoots: async () => ({ ...harness.roots, opencodeDbPaths: paths }),
    historyDays: null,
    clock
  })
  indexer = subject
  await subject.start()
  await subject.reconcile({ full: true })
  expect(openEngine().search({ query: 'winningcopyneedle' }).hits).toHaveLength(1)
  expect(openEngine().search({ query: 'alternativecopyneedle' }).hits).toHaveLength(0)
  await rm(dbPath())
  paths = [alternative]
  await subject.reconcile({ full: true })
  expect(openEngine().search({ query: 'alternativecopyneedle' }).hits[0]?.sessionId).toBe(
    'ses_shared'
  )
  expect(openEngine().search({ query: 'winningcopyneedle' }).hits).toHaveLength(0)
  expect(openEngine().search({ query: 'primaryonlyneedle' }).hits).toHaveLength(0)
})

it('retains refused database membership while healthy owners settle and retries only the refused full observation', async () => {
  const alternative = join(harness.root, 'opencode-db', 'opencode-alternative.db')
  writeOpenCodeSqliteDatabase(dbPath(), [
    { id: 'ses_primary', turns: [{ role: 'user', parts: ['preservedneedle'] }] }
  ])
  writeOpenCodeSqliteDatabase(alternative, [
    { id: 'ses_alternative', turns: [{ role: 'user', parts: ['healthyneedle'] }] }
  ])
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: { ...harness.roots, opencodeDbPaths: [dbPath(), alternative] },
    historyDays: null,
    clock
  })
  indexer = subject
  await subject.start()
  await rename(dbPath(), `${dbPath()}.saved`)
  await writeFile(dbPath(), 'temporarily unreadable sqlite')
  appendOpenCodeSqliteTurn(alternative, 'ses_alternative', {
    role: 'assistant',
    parts: ['healthyupdateneedle']
  })
  await subject.reconcile({ full: true })
  expect(openEngine().search({ query: 'preservedneedle' }).hits).toHaveLength(1)
  expect(openEngine().search({ query: 'healthyupdateneedle' }).hits).toHaveLength(1)
  await rm(dbPath())
  await rename(`${dbPath()}.saved`, dbPath())
  openCodeListObservations.length = 0
  clock.advance(20000)
  await subject.settled()
  expect(
    openCodeListObservations.filter((observation) => observation.paths[0] === alternative)
  ).toEqual([{ paths: [alternative], limit: 12, rows: 1 }])
  expect(
    openCodeListObservations.filter((observation) => observation.paths[0] === dbPath())
  ).toEqual([{ paths: [dbPath()], limit: Infinity, rows: 1 }])
  expect(openEngine().search({ query: 'preservedneedle' }).hits).toHaveLength(1)
})

it('keeps full membership proofs separate when v1 and v2 share one physical database', async () => {
  writeVault()
  const subject = await startIndexer()
  expect(openEngine().search({ query: ANSWER }).hits).toHaveLength(1)
  const db = new SyncDatabase(dbPath())
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, time_created INTEGER, time_updated INTEGER);
    INSERT INTO session_v2 VALUES ('ses_capture', 1740000000000, 1740000010000)`)
  db.close()
  const changed = new SyncDatabase(dbPath())
  changed.prepare('DELETE FROM session WHERE id=?').run(SESSION)
  changed.close()
  await subject.reconcile({ full: true })
  // The v2 copy of this ID is not positive membership evidence for the removed v1 row.
  expect(openEngine().search({ query: ANSWER }).hits).toHaveLength(0)
  expect(openEngine().search({ query: OTHER }).hits).toHaveLength(1)
})

it('keeps indexed rows when an existing physical database becomes empty or unrecognized', async () => {
  writeVault()
  const subject = await startIndexer()
  const db = new SyncDatabase(dbPath())
  db.exec('DELETE FROM session')
  db.close()
  await subject.reconcile({ full: true })
  expect(openEngine().search({ query: ANSWER }).hits).toHaveLength(1)
  const changed = new SyncDatabase(dbPath())
  changed.exec('DROP TABLE session')
  changed.close()
  await subject.reconcile({ full: true })
  expect(openEngine().search({ query: ANSWER }).hits).toHaveLength(1)
})
