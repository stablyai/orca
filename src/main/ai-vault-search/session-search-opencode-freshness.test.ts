import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { sessionCandidatesFromDiscoveries } from '../ai-vault/session-scanner-candidates'
import {
  applyOpenCodeSqliteSchema,
  insertOpenCodeMessage,
  insertOpenCodePart,
  insertOpenCodeSession,
  touchOpenCodeSession
} from '../ai-vault/session-scanner-opencode-sqlite-fixtures'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests,
  type SessionParseStats
} from '../ai-vault/session-scanner-parse-cache'
import { discoverAiVaultSessionSources } from '../ai-vault/session-scanner-source-discovery'
import { isolatedScanRoots } from '../ai-vault/session-scanner-test-fixtures'
import type { AiVaultScanOptions } from '../ai-vault/session-scanner-types'
import {
  registerSessionSearchIndexSink,
  withSessionSearchIndexRequired
} from '../ai-vault/session-search-capture'
import Database from '../sqlite/sync-database'
import { SessionSearchStore } from './session-search-store'

// Why: a source-level suite has no built worker bundle, so the SQLite reads run
// inline here; production fails closed when the bundle is absent.
vi.mock('../ai-vault/session-scanner-opencode-sqlite-worker-spawn', async () => {
  const [{ listOpenCodeSqliteSessions }, { parseOpenCodeSqliteSession }] = await Promise.all([
    import('../ai-vault/session-scanner-opencode-sqlite-list'),
    import('../ai-vault/session-scanner-opencode-sqlite')
  ])
  return {
    listOpenCodeSqliteSessionsViaWorker: listOpenCodeSqliteSessions,
    parseOpenCodeSqliteSessionViaWorker: parseOpenCodeSqliteSession
  }
})

const SESSION_ID = 'ses_fresh0000000000000000000000'
const CREATED_MS = 1_777_634_000_000

let tempRoots: string[] = []
let store: SessionSearchStore
let apply: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  resetSessionParseCacheForTests()
  store = new SessionSearchStore(join(await makeTempDir(), 'index.sqlite'), (error) => {
    throw error
  })
  apply = vi.spyOn(store, 'apply')
  registerSessionSearchIndexSink(store)
})

afterEach(async () => {
  registerSessionSearchIndexSink(null)
  store.close()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeTempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-opencode-freshness-'))
  tempRoots.push(root)
  return root
}

/** One opencode.db holding a single session with its first user turn. */
async function createOpenCodeDb(): Promise<string> {
  const dbPath = join(await makeTempDir(), 'opencode.db')
  const db = new Database(dbPath)
  applyOpenCodeSqliteSchema(db)
  insertOpenCodeSession(db, {
    id: SESSION_ID,
    title: 'Ballast planning',
    timeCreated: CREATED_MS,
    timeUpdated: CREATED_MS + 1_000
  })
  insertOpenCodeMessage(db, {
    id: 'msg_1',
    sessionId: SESSION_ID,
    role: 'user',
    timeCreated: CREATED_MS + 500
  })
  insertOpenCodePart(db, {
    id: 'prt_1',
    messageId: 'msg_1',
    sessionId: SESSION_ID,
    timeCreated: CREATED_MS + 500,
    text: 'how do we raise the vacuum quota for the intake pump'
  })
  db.close()
  return dbPath
}

/** Appends an assistant turn and bumps the session row, as OpenCode does. */
async function appendAssistantTurn(dbPath: string): Promise<void> {
  const db = new Database(dbPath)
  insertOpenCodeMessage(db, {
    id: 'msg_2',
    sessionId: SESSION_ID,
    role: 'assistant',
    timeCreated: CREATED_MS + 1_500
  })
  insertOpenCodePart(db, {
    id: 'prt_2',
    messageId: 'msg_2',
    sessionId: SESSION_ID,
    timeCreated: CREATED_MS + 1_500,
    text: 'drain the ballast tanks before the next calibration run'
  })
  touchOpenCodeSession(db, { id: SESSION_ID, timeUpdated: CREATED_MS + 2_000 })
  db.close()
}

/** Mirrors SessionSearchService.refreshRecent: discover, then parse in required mode. */
async function refreshRecent(dbPath: string): Promise<SessionParseStats> {
  const options: AiVaultScanOptions = {
    ...isolatedScanRoots(await makeTempDir()),
    opencodeDbPaths: [dbPath]
  }
  const issues: AiVaultScanIssue[] = []
  const discoveries = await discoverAiVaultSessionSources({ options, limitPerAgent: 12, issues })
  const candidates = await sessionCandidatesFromDiscoveries(discoveries, options)
  const stats = createSessionParseStats()
  await withSessionSearchIndexRequired(async () => {
    for (const candidate of candidates) {
      await parseAgentSessionFileCached(candidate, process.platform, stats)
    }
  })
  return stats
}

describe('OpenCode SQLite session freshness', () => {
  it('re-indexes a session that gained a message since the last parse', async () => {
    const dbPath = await createOpenCodeDb()

    const first = await refreshRecent(dbPath)
    expect(first.fullParses).toBe(1)
    expect(store.search({ query: 'vacuum quota' }).hits).toMatchObject([
      { agent: 'opencode', sessionId: SESSION_ID }
    ])
    expect(store.coverage().messagesIndexed).toBe(1)

    await appendAssistantTurn(dbPath)
    const second = await refreshRecent(dbPath)

    expect(second.reused).toBe(0)
    expect(second.fullParses).toBe(1)
    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply.mock.calls[1]?.[0]).toMatchObject({ mode: 'replace' })
    expect(store.search({ query: 'ballast tanks' }).hits).toMatchObject([
      { agent: 'opencode', sessionId: SESSION_ID }
    ])
    // The replace re-emits the whole session, so the first turn stays searchable.
    expect(store.search({ query: 'vacuum quota' }).hits).toHaveLength(1)
    expect(store.coverage().messagesIndexed).toBe(2)
  })

  it('reuses the cached parse and leaves the index alone when nothing changed', async () => {
    const dbPath = await createOpenCodeDb()
    await refreshRecent(dbPath)
    expect(apply).toHaveBeenCalledTimes(1)

    const second = await refreshRecent(dbPath)

    expect(second.reused).toBe(1)
    expect(second.fullParses).toBe(0)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(store.coverage().messagesIndexed).toBe(1)
  })
})
