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
import type { AiVaultScanOptions, SessionFileCandidate } from '../ai-vault/session-scanner-types'
import {
  registerSessionSearchIndexSink,
  withSessionSearchIndexRequired
} from '../ai-vault/session-search-capture'
import Database from '../sqlite/sync-database'
import { parseSearchCandidates } from './session-search-parse-candidates'
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

async function candidatesFor(dbPath: string): Promise<SessionFileCandidate[]> {
  const options: AiVaultScanOptions = {
    ...isolatedScanRoots(await makeTempDir()),
    opencodeDbPaths: [dbPath]
  }
  const issues: AiVaultScanIssue[] = []
  const discoveries = await discoverAiVaultSessionSources({ options, limitPerAgent: 12, issues })
  return sessionCandidatesFromDiscoveries(discoveries, options)
}

/**
 * Fail the capture parts read after one row, standing in for the I/O-family
 * SQLite error that is what actually reaches that catch: a corrupt part blob is
 * handled per row, and a corrupt message blob fails earlier in the session query.
 */
function failCapturePartsRead(): void {
  const prepare = Database.prototype.prepare
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database,
    sql: string
  ) {
    const statement = prepare.call(this, sql)
    if (!sql.includes('p.data AS data')) {
      return statement
    }
    return {
      iterate: (...args: Parameters<typeof statement.iterate>) =>
        (function* () {
          for (const row of statement.iterate(...args)) {
            yield row
            throw new Error('disk I/O error')
          }
        })()
    } as unknown as ReturnType<typeof prepare>
  })
}

/** Mirrors SessionSearchService.refreshRecent: discover, then parse in required mode. */
async function refreshRecent(dbPath: string): Promise<SessionParseStats> {
  const candidates = await candidatesFor(dbPath)
  const stats = createSessionParseStats()
  await withSessionSearchIndexRequired(async () => {
    for (const candidate of candidates) {
      await parseAgentSessionFileCached(candidate, process.platform, stats)
    }
  })
  return stats
}

describe('OpenCode SQLite session freshness', () => {
  it('indexes older turns beyond the bounded preview window', async () => {
    const dbPath = await createOpenCodeDb()
    const db = new Database(dbPath)
    for (let i = 0; i < 105; i += 1) {
      insertOpenCodeMessage(db, {
        id: `later_${i}`,
        sessionId: SESSION_ID,
        role: 'assistant',
        timeCreated: CREATED_MS + 2000 + i
      })
      insertOpenCodePart(db, {
        id: `part_${i}`,
        messageId: `later_${i}`,
        sessionId: SESSION_ID,
        timeCreated: CREATED_MS + 2000 + i,
        text: `newer response ${i}`
      })
    }
    db.close()
    await refreshRecent(dbPath)
    expect(store.search({ query: 'vacuum quota' }).hits).toHaveLength(1)
    expect(store.coverage().messagesIndexed).toBe(106)
  })

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

  it('keeps listing a session whose part blob the capture read cannot decode', async () => {
    const dbPath = await createOpenCodeDb()
    const db = new Database(dbPath)
    // Valid JSON that is not an object, so SQLite's json_extract tolerates it in
    // the preview query and only the search capture read has to survive it.
    db.prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES ('prt_bad', 'msg_1', ?, ?, ?, 'null')`
    ).run(SESSION_ID, CREATED_MS + 600, CREATED_MS + 600)
    db.close()

    // The parse must not reject: an index failure may never cost the session its
    // place in the list, and the readable turns must still reach the index.
    await expect(refreshRecent(dbPath)).resolves.toMatchObject({ fullParses: 1 })
    expect(store.search({ query: 'vacuum quota' }).hits).toMatchObject([
      { agent: 'opencode', sessionId: SESSION_ID }
    ])
    expect(store.coverage().messagesIndexed).toBe(1)
  })

  it('refuses the file cursor when the capture read degrades, and re-parses next scan', async () => {
    const dbPath = await createOpenCodeDb()
    const [candidate] = await candidatesFor(dbPath)
    failCapturePartsRead()

    // The session still lists: a degraded search read may not cost it its place.
    await expect(refreshRecent(dbPath)).resolves.toMatchObject({ fullParses: 1 })
    expect(store.coverage().messagesIndexed).toBe(0)
    // The half-read rows are discarded and no cursor is published, so nothing
    // marks this file indexed at its current mtime.
    expect(store.indexedFile(candidate!.file.path, null)).toBeNull()
    // A retryable read is not a write failure: the badge must not go red for it.
    expect(store.indexing.snapshot().phase).not.toBe('error')
    expect(store.failures).toBe(0)

    vi.mocked(Database.prototype.prepare).mockRestore()
    // A cold parse cache is the case the published cursor used to poison: the
    // backfill lane consults the index alone and used to skip the session.
    resetSessionParseCacheForTests()
    await parseSearchCandidates(store, await candidatesFor(dbPath))

    expect(store.search({ query: 'vacuum quota' }).hits).toMatchObject([
      { agent: 'opencode', sessionId: SESSION_ID }
    ])
    expect(store.coverage().messagesIndexed).toBe(1)
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
