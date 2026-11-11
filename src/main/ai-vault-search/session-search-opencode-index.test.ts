import './session-search-worker.test-fixture'
import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'
import { rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import * as filesystem from '../native-chat/wsl-transcript-fs-access'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Replace worker transport while exercising the real SQLite readers.
export let openCodeListHook:
  | ((
      agent: 'opencode' | 'opencode2',
      issues: AiVaultScanIssue[],
      limit: number
    ) => Promise<void> | void)
  | null = null
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
      listOpenCode2SqliteSessionsViaWorker: async (
        args: Parameters<typeof listOpenCode2SqliteSessions>[0]
      ) => {
        const candidates = await listOpenCode2SqliteSessions(args)
        await own.openCodeListHook?.('opencode2', args.issues, args.limit)
        return candidates
      },
      resolveOpenCodeSqliteWorkerEntryPath: () => null,
      listOpenCodeSqliteSessionsViaWorker: (
        args: Parameters<typeof list.listOpenCodeSqliteSessions>[0]
      ) =>
        list.listOpenCodeSqliteSessions(args).then(async (candidates) => {
          await own.openCodeListHook?.('opencode', args.issues, args.limit)
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
import { readWholeTranscript } from '../ai-vault/transcripts/session-transcript-reader'
import { buildOpenCodeSqliteCandidatePath } from '../../shared/opencode-sqlite-session-path'
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
  openCodeListHook = null
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

async function finishPendingObservation(subject: SessionSearchIndexer): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    if (subject.status().phase !== 'indexing') {
      return
    }
    await subject.reconcile()
  }
  throw new Error('Database observation did not finish')
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
  await finishPendingObservation(started)
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
  await finishPendingObservation(subject)
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
  appendOpenCodeSqliteTurn(dbPath(), 'ses_primary', {
    role: 'assistant',
    parts: ['recoveredprimaryneedle']
  })
  clock.advance(20000)
  await subject.settled()
  await finishPendingObservation(subject)
  expect(openEngine().search({ query: 'recoveredprimaryneedle' }).hits).toHaveLength(1)
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
  await finishPendingObservation(subject)
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

it.each([40, 400])(
  'acknowledges one complete full observation of an actively changing %s-row database',
  async (population) => {
    writeOpenCodeSqliteDatabase(
      dbPath(),
      Array.from({ length: population }, (_, index) => ({
        id: `ses_${index}`,
        turns: [{ role: 'user', parts: ['activearchive'] }]
      }))
    )
    openCodeListHook = (agent) => {
      if (agent === 'opencode') {
        appendOpenCodeSqliteTurn(dbPath(), 'ses_0', {
          role: 'assistant',
          parts: ['activewalneedle']
        })
      }
    }
    const subject = await startIndexer()
    for (let cycle = 0; cycle < 5; cycle++) {
      clock.advance(20000)
      await subject.settled()
    }
    expect(
      openCodeListObservations.filter((observation) => observation.limit === Infinity)
    ).toHaveLength(1)
    expect(
      openCodeListObservations
        .filter((observation) => observation.limit === 12)
        .every((observation) => observation.rows <= 12)
    ).toBe(true)
    expect(openEngine().search({ query: 'activewalneedle' }).hits[0]?.sessionId).toBe('ses_0')
    openCodeListHook = null
    await subject.reconcile({ full: true })
    await finishPendingObservation(subject)
    expect(subject.status().phase).toBe('current')
  }
)

it('chooses the original earlier database when an equal-time alias is imported later', async () => {
  const alternative = join(harness.root, 'opencode-db', 'opencode-alternative.db')
  writeOpenCodeSqliteDatabase(dbPath(), [
    { id: 'ses_other', turns: [{ role: 'user', parts: ['otherrow'] }] }
  ])
  writeOpenCodeSqliteDatabase(alternative, [
    { id: 'ses_shared', turns: [{ role: 'user', parts: ['laterdatabasecopy'] }] }
  ])
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: { ...harness.roots, opencodeDbPaths: [dbPath(), alternative] },
    historyDays: null,
    clock
  })
  indexer = subject
  await subject.start()
  await finishPendingObservation(subject)
  expect(openEngine().search({ query: 'laterdatabasecopy' }).hits[0]?.sessionId).toBe('ses_shared')
  writeOpenCodeSqliteDatabase(dbPath(), [
    { id: 'ses_shared', turns: [{ role: 'user', parts: ['earlierdatabasecopy'] }] }
  ])
  await subject.reconcile({ full: true })
  expect(openEngine().search({ query: 'earlierdatabasecopy' }).hits[0]?.sessionId).toBe(
    'ses_shared'
  )
  expect(openEngine().search({ query: 'laterdatabasecopy' }).hits).toHaveLength(0)
  // Opening the retained raw alias still parses it for History, without republishing search output.
  const foreground = await readWholeTranscript({
    candidate: {
      agent: 'opencode',
      codexHome: null,
      file: {
        path: buildOpenCodeSqliteCandidatePath(alternative, 'ses_shared'),
        mtimeMs: 1740000060000,
        modifiedAt: '2025-02-19T21:21:00.000Z'
      }
    },
    platform: process.platform
  })
  await subject.settled()
  expect(foreground?.sessionId).toBe('ses_shared')
  expect(openEngine().search({ query: 'laterdatabasecopy' }).hits).toHaveLength(0)
})

it('settles a healthy physical full list when another family reports a concurrent refusal', async () => {
  writeOpenCodeSqliteDatabase(dbPath(), [
    { id: 'ses_healthy', turns: [{ role: 'user', parts: ['healthysourcecopy'] }] }
  ])
  let announceOther!: () => void, releaseOther!: () => void
  const otherStarted = new Promise<void>((resolve) => {
    announceOther = resolve
  })
  const otherReleased = new Promise<void>((resolve) => {
    releaseOther = resolve
  })
  openCodeListHook = async (agent, issues) => {
    if (agent === 'opencode2') {
      issues.push({
        agent: 'opencode2',
        path: dbPath(),
        message: 'fixture refused family'
      })
      announceOther()
      await otherReleased
    } else {
      await otherStarted
      releaseOther()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  const subject = await startIndexer()
  openCodeListHook = null
  clock.advance(20000)
  await subject.settled()
  expect(
    openCodeListObservations.filter((observation) => observation.limit === Infinity)
  ).toHaveLength(1)
  expect(openEngine().search({ query: 'healthysourcecopy' }).hits[0]?.sessionId).toBe('ses_healthy')
})

it('parks a persistently partial physical observation and wakes it on an explicit full request', async () => {
  writeOpenCodeSqliteDatabase(dbPath(), [
    { id: 'ses_recoverable', turns: [{ role: 'user', parts: ['recoverabledatabase'] }] }
  ])
  openCodeListHook = (agent, issues) => {
    if (agent === 'opencode') {
      issues.push({ agent: 'opencode', path: dbPath(), message: 'fixture partial read' })
    }
  }
  const subject = await startIndexer()
  for (let cycle = 0; cycle < 6; cycle++) {
    clock.advance(20000)
    await subject.settled()
  }
  expect(
    openCodeListObservations.filter((observation) => observation.limit === Infinity)
  ).toHaveLength(3)
  expect(openEngine().search({ query: 'recoverabledatabase' }).hits[0]?.sessionId).toBe(
    'ses_recoverable'
  )
  openCodeListHook = null
  await subject.reconcile({ full: true })
  await finishPendingObservation(subject)
  expect(
    openCodeListObservations.filter((observation) => observation.limit === Infinity)
  ).toHaveLength(4)
  expect(subject.status().phase).toBe('current')
})

it('retains a restored old row when a family listing loses the earlier absence proof', async () => {
  const removed = Array.from({ length: 512 }, (_, index) => ({
    id: `ses_removed_${index}`,
    turns: [{ role: 'user' as const, parts: ['removedarchive'] }]
  }))
  writeOpenCodeSqliteDatabase(dbPath(), [
    ...removed,
    { id: 'ses_restored', turns: [{ role: 'user', parts: ['restoredoldneedle'] }] },
    ...Array.from({ length: 20 }, (_, index) => ({
      id: `ses_keeper_${index}`,
      turns: [{ role: 'user' as const, parts: ['keeperarchive'] }]
    }))
  ])
  const source = new SyncDatabase(dbPath())
  source.prepare("UPDATE session SET time_updated=1740000000001 WHERE id='ses_restored'").run()
  source.close()
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: {
      ...harness.roots,
      opencodeDbPaths: undefined,
      opencodeStorageDir: join(dirname(dbPath()), 'storage')
    },
    historyDays: null,
    clock,
    discoveryDeadlineMs: 0,
    fullSweepEveryCycles: 1000
  })
  indexer = subject
  await subject.start()
  await finishPendingObservation(subject)
  for (let cycle = 0; cycle < 8; cycle++) {
    clock.advance(20000)
    await subject.settled()
  }
  expect(openEngine().search({ query: 'restoredoldneedle' }).hits).toHaveLength(1)
  const changed = new SyncDatabase(dbPath())
  changed.exec(
    "CREATE TABLE saved_session AS SELECT * FROM session WHERE id='ses_restored'; DELETE FROM session WHERE id NOT LIKE 'ses_keeper_%'"
  )
  changed.close()
  await subject.reconcile({ full: true })
  // The first bounded retirement batch leaves this older row owed.
  expect(openEngine().search({ query: 'restoredoldneedle' }).hits).toHaveLength(1)
  const restored = new SyncDatabase(dbPath())
  restored.exec('INSERT INTO session SELECT * FROM saved_session')
  restored.close()
  const actual = filesystem.wslGatedReaddir
  let refused = false
  const listing = vi.spyOn(filesystem, 'wslGatedReaddir').mockImplementation((path, ...rest) => {
    if (path === dirname(dbPath()) && !refused) {
      refused = true
      return Promise.reject(
        Object.assign(new Error('fixture family listing refusal'), { code: 'EIO' })
      )
    }
    return actual(path, ...rest)
  })
  try {
    clock.advance(20000)
    await subject.settled()
    expect(refused).toBe(true)
    expect(openEngine().search({ query: 'restoredoldneedle' }).hits).toHaveLength(1)
    await subject.reconcile({ full: true })
    expect(openEngine().search({ query: 'restoredoldneedle' }).hits).toHaveLength(1)
  } finally {
    listing.mockRestore()
  }
})

it('settles a full attempt blocked by persistent family enumeration while retaining recovery', async () => {
  writeOpenCodeSqliteDatabase(dbPath(), [
    { id: 'ses_family', turns: [{ role: 'user', parts: ['retainedfamilyneedle'] }] }
  ])
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: {
      ...harness.roots,
      opencodeDbPaths: undefined,
      opencodeStorageDir: join(dirname(dbPath()), 'storage')
    },
    historyDays: null,
    clock,
    fullSweepEveryCycles: 1000
  })
  indexer = subject
  await subject.start()
  const completed = subject.status().lastSweepCompletedAt
  expect(openEngine().search({ query: 'retainedfamilyneedle' }).hits).toHaveLength(1)
  const actual = filesystem.wslGatedReaddir
  let refused = true
  const reads = vi.spyOn(filesystem, 'wslGatedReaddir').mockImplementation((path, ...rest) => {
    if (refused && path === dirname(dbPath())) {
      return Promise.reject(Object.assign(new Error('fixture family refusal'), { code: 'EACCES' }))
    }
    return actual(path, ...rest)
  })
  try {
    clock.costPerNowMs = 1
    await subject.reconcile({ full: true })
    for (let cycle = 0; cycle < 6; cycle++) {
      clock.advance(20000)
      await subject.settled()
    }
    expect(subject.status().lastSweepCompletedAt).not.toBe(completed)
    expect(openEngine().search({ query: 'retainedfamilyneedle' }).hits).toHaveLength(1)
    refused = false
    appendOpenCodeSqliteTurn(dbPath(), 'ses_family', {
      role: 'assistant',
      parts: ['recoveredfamilyneedle']
    })
    await subject.reconcile({ full: true })
    await finishPendingObservation(subject)
    expect(openEngine().search({ query: 'recoveredfamilyneedle' }).hits).toHaveLength(1)
    expect(subject.status().phase).toBe('current')
  } finally {
    reads.mockRestore()
  }
})
