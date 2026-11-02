import { appendFile, chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import SyncDatabase from '../sqlite/sync-database'
import { SessionSearchIndexer } from './session-search-indexer'
import { SessionSearchEngine } from './session-search-engine'
import { addSyntheticSession } from './session-search-engine-test-fixture'
import { openSessionSearchDatabase, SESSION_SEARCH_SCHEMA_VERSION } from './session-search-schema'
import { SessionSearchStore } from './session-search-store'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'

const ID = 'session_v2-fixture'
const CWD = '/synthetic/kimi-app'
const TIME = Date.parse('2026-10-04T14:00:00.000Z')
let harness: SessionSearchIndexerHarness
let indexer: SessionSearchIndexer
let clock: FakeSessionSearchClock
let db: SyncDatabase | undefined
let engine: SessionSearchEngine
let sessionDir: string

const tool = (text: string, id = 'call-1', time: string | number = TIME) => ({
  type: 'agent.message.appended',
  time,
  message: {
    message: { role: 'tool', toolCallId: id, content: [{ type: 'text', text }] },
    meta: {}
  }
})
const lines = (records: unknown[]) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  harness = await openSessionSearchIndexerHarness('ss-kimi-v2')
  clock = new FakeSessionSearchClock()
  sessionDir = join(harness.roots.kimiSessionsDir!, 'wd_fixture', ID)
  await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true })
  await mkdir(join(sessionDir, 'agents', 'agent-1'), { recursive: true })
  await writeFile(
    join(sessionDir, 'state.json'),
    JSON.stringify({
      version: 2,
      cwd: CWD,
      createdAt: TIME - 1000,
      updatedAt: TIME,
      agents: { main: { type: 'main' }, 'agent-1': { type: 'subagent', parentAgentId: 'main' } }
    })
  )
  await writeFile(
    join(dirname(harness.roots.kimiSessionsDir!), 'session_index.jsonl'),
    lines([{ sessionId: ID, workDir: CWD }])
  )
  await writeFile(
    join(sessionDir, 'agents', 'main', 'wire.jsonl'),
    lines([tool('mainresultfixture')])
  )
  await writeFile(
    join(sessionDir, 'agents', 'agent-1', 'wire.jsonl'),
    lines([tool('childresultfixture')])
  )
  indexer = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock,
    reconcileIntervalMs: 20_000
  })
  await indexer.start()
  db = new SyncDatabase(harness.databasePath)
  engine = new SessionSearchEngine(db)
})

afterEach(async () => {
  db?.close()
  db = undefined
  indexer?.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness?.cleanup()
})

it('indexes main and child tools only in all scope and respects project and since', () => {
  const filters = { agents: ['kimi'] as const, scopePaths: [CWD], since: '2026-10-04T13:15:54Z' }
  expect(
    engine
      .search({ query: 'mainresultfixture', scope: 'all', filters })
      .hits.map((h) => h.sessionId)
  ).toEqual([ID])
  expect(
    engine
      .search({ query: 'childresultfixture', scope: 'all', filters })
      .hits.map((h) => h.sessionId)
  ).toEqual([ID])
  expect(
    engine.search({ query: 'childresultfixture', scope: 'conversation', filters }).hits
  ).toEqual([])
  expect(
    engine.search({ query: 'mainresultfixture', filters: { scopePaths: ['/synthetic/other'] } })
      .hits
  ).toEqual([])
  expect(
    engine.search({ query: 'mainresultfixture', filters: { since: '2026-10-05T00:00:00Z' } }).hits
  ).toEqual([])
  expect(engine.search({ query: 'mainresultfixture' }).hits[0]?.evidence?.timestamp).toBe(
    '2026-10-04T14:00:00.000Z'
  )
})

it('refreshes a child wire append without rewriting state and does not duplicate mirrored results', async () => {
  const record = tool('freshchildresult', 'child-call-2', '2026-10-05T00:00:00.000Z')
  const childWire = join(sessionDir, 'agents', 'agent-1', 'wire.jsonl')
  await appendFile(childWire, lines([record, record]))
  clock.advance(20_000)
  await indexer.settled()
  expect(
    engine
      .search({
        query: 'freshchildresult',
        scope: 'all',
        filters: { since: '2026-10-04T23:59:59Z', scopePaths: [CWD] }
      })
      .hits.map((h) => h.sessionId)
  ).toEqual([ID])
  const before = indexer.status().messagesIndexed
  clock.advance(20_000)
  await indexer.settled()
  expect(indexer.status().messagesIndexed).toBe(before)
  expect(before).toBe(3)
})

it('adds the fingerprint column to an old index without losing cached Claude rows or incarnation', () => {
  indexer.close()
  addSyntheticSession(db!, { id: 100, agent: 'claude', text: 'retainedclaudefixture' })
  const incarnation = db!
    .prepare("SELECT value FROM meta WHERE key = 'index_incarnation'")
    .get()?.value
  db!.exec('ALTER TABLE files DROP COLUMN content_fingerprint')
  db!.close()
  db = openSessionSearchDatabase(harness.databasePath)
  engine = new SessionSearchEngine(db)
  expect(
    engine
      .search({ query: 'retainedclaudefixture', filters: { agents: ['claude'] } })
      .hits.map((h) => h.sessionId)
  ).toEqual(['100'])
  expect(db.prepare("SELECT value FROM meta WHERE key = 'index_incarnation'").get()?.value).toBe(
    incarnation
  )
  expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value).toBe(
    String(SESSION_SEARCH_SCHEMA_VERSION)
  )
  expect(engine.search({ query: 'mainresultfixture' }).hits.map((h) => h.sessionId)).toEqual([ID])
})

it('retries a held-out session when its child content changes at an unchanged state stat', async () => {
  harness.write((database) =>
    database.exec("UPDATE files SET state = 'failed', fail_count = 3, failed_mtime_ms = mtime_ms")
  )
  await appendFile(
    join(sessionDir, 'agents', 'agent-1', 'wire.jsonl'),
    lines([tool('recoveredchildfixture', 'recovered')])
  )
  clock.advance(20_000)
  await indexer.settled()
  expect(
    engine.search({ query: 'recoveredchildfixture' }).hits.map((hit) => hit.sessionId)
  ).toEqual([ID])
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'bounds retries at an unreadable child fingerprint while preserving committed results',
  async () => {
    const childWire = join(sessionDir, 'agents', 'agent-1', 'wire.jsonl')
    const observer = new SessionSearchStore(harness.databasePath, (error) => {
      throw error
    })
    await chmod(childWire, 0)
    try {
      for (let cycle = 0; cycle < 5; cycle++) {
        clock.advance(20_000)
        await indexer.settled()
      }
      expect(
        observer.files().find((file) => file.path === join(sessionDir, 'state.json'))?.failCount
      ).toBe(3)
      expect(
        engine.search({ query: 'mainresultfixture' }).hits.map((hit) => hit.sessionId)
      ).toEqual([ID])
    } finally {
      await chmod(childWire, 0o600)
      observer.close()
    }
  }
)
