import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import {
  configureSessionParseCachePersistence,
  flushSessionParseCachePersist,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests
} from './session-parse-cache-persistence'
import {
  SESSION_PARSE_CACHE_SCHEMA_VERSION,
  SessionParseCacheDatabase
} from './session-parse-cache-database'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  type SessionParseStats
} from './session-scanner-parse-cache'
import {
  invalidateSessionParseCacheEntry,
  resetSessionParseCacheForTests
} from './session-parse-cache-store'
import type * as ParseCacheModule from './session-scanner-parse-cache'
import { parseSessionCandidate } from '../parsing/session-scanner-candidate-parse'
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from '../transcripts/session-transcript-record-budget'
import type { FileWithMtime, SessionFileCandidate } from '../session-scanner-types'

const hooks = vi.hoisted(() => {
  const state: { beforeParse: (() => Promise<void>) | null } = { beforeParse: null }
  return state
})

// Preserve real I/O while measuring whether an uninitialized cache touches disk.
vi.mock('node:fs/promises', { spy: true })
vi.mock('./session-scanner-parse-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof ParseCacheModule>()
  return {
    ...actual,
    parseListedSessionFile: async (...args: Parameters<typeof actual.parseListedSessionFile>) => {
      await hooks.beforeParse?.()
      return actual.parseListedSessionFile(...args)
    }
  }
})

const APP_VERSION = '1.2.3-test'

let tempRoots: string[] = []

beforeEach(() => {
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
  hooks.beforeParse = null
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetSessionParseCachePersistenceForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeTempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-parse-cache-persist-'))
  tempRoots.push(root)
  return root
}

async function claudeCandidate(path: string): Promise<SessionFileCandidate> {
  const fileStat = await stat(path)
  const file: FileWithMtime = {
    path,
    mtimeMs: fileStat.mtimeMs,
    modifiedAt: fileStat.mtime.toISOString(),
    sizeBytes: fileStat.size
  }
  return { agent: 'claude', file, codexHome: null }
}

function userRecord(index: number, text: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    timestamp: new Date(1740000000000 + index * 60_000).toISOString(),
    cwd: '/repo/app',
    gitBranch: 'main',
    message: { role: 'user', content: text }
  })
}

function assistantRecord(index: number, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    timestamp: new Date(1740000000000 + index * 60_000).toISOString(),
    message: {
      role: 'assistant',
      model: 'claude-fable-5',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 100, output_tokens: 40 }
    }
  })
}

async function writeTranscript(
  root: string,
  name = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
): Promise<string> {
  const path = join(root, `${name}.jsonl`)
  await writeFile(path, `${userRecord(0, 'first question')}\n${assistantRecord(1, 'answer')}\n`)
  return path
}

async function parse(path: string): Promise<SessionParseStats> {
  const stats = createSessionParseStats()
  await parseAgentSessionFileCached(await claudeCandidate(path), process.platform, stats)
  return stats
}

function simulateRestart(cacheFile: string): void {
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
  initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
}

describe('session parse cache persistence', () => {
  it('adds physical evidence to an existing schema 9 cache without dropping rows or independent tables', async () => {
    const root = await makeTempDir()
    const path = join(root, 'cache.sqlite')
    const initial = new SessionParseCacheDatabase(path)
    const entry = { mtimeMs: 1, sizeBytes: 2, platform: process.platform, session: null }
    initial.write([['/old/transcript', entry]], 123)
    initial.writeScopeCwds([['/old/scope', { ...entry, cwd: '/repo' }]], 123)
    initial.close()
    const old = new SyncDatabase(path)
    old.exec(`ALTER TABLE rows DROP COLUMN identity;
      ALTER TABLE scope_cwds DROP COLUMN identity;
      CREATE TABLE independent_checkpoint(value TEXT);
      INSERT INTO independent_checkpoint VALUES ('retained');`)
    old.close()
    const upgraded = new SessionParseCacheDatabase(path)
    expect(upgraded.read('/old/transcript')).toMatchObject(entry)
    expect(upgraded.readScopeCwds(['/old/scope']).found.get('/old/scope')?.read?.cwd).toBe('/repo')
    upgraded.close()
    const inspect = new SyncDatabase(path)
    try {
      expect(inspect.prepare('SELECT value FROM independent_checkpoint').get()?.value).toBe(
        'retained'
      )
      expect(
        inspect
          .prepare('PRAGMA table_info(rows)')
          .all()
          .some((column) => column.name === 'identity')
      ).toBe(true)
      expect(
        inspect.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value
      ).toBe('9')
    } finally {
      inspect.close()
    }
  })

  it('reconstructs unreadable diagnostics from a version 8 row before reusing it', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    const transcript = join(root, 'unreadable.jsonl')
    await writeFile(
      transcript,
      `${userRecord(0, 'x'.repeat(MAX_SESSION_TRANSCRIPT_RECORD_BYTES))}\n`
    )
    const candidate = await claudeCandidate(transcript)
    const session = await parseAgentSessionFileCached(candidate, process.platform)
    const oldDatabase = new SyncDatabase(join(root, 'session-parse-cache.sqlite'))
    oldDatabase.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '8');
      CREATE TABLE rows(path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size_bytes INTEGER,
        platform TEXT NOT NULL, sidecar TEXT, session TEXT NOT NULL, seen_at INTEGER NOT NULL);
    `)
    oldDatabase.prepare('INSERT INTO rows VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      transcript,
      candidate.file.mtimeMs,
      candidate.file.sizeBytes ?? null,
      process.platform,
      null,
      JSON.stringify(session),
      // ast-grep-ignore: test-no-wall-clock -- Real database expiry uses current time for persisted row ages.
      Date.now()
    )
    oldDatabase.close()

    simulateRestart(cacheFile)
    const parseStats = createSessionParseStats()
    const context = {
      platform: process.platform,
      executionHostId: 'local' as const,
      listed: true,
      parseStats
    }
    expect((await parseSessionCandidate(candidate, context)).issue).toMatchObject({
      messageCode: 'transcriptTooLarge'
    })
    expect(parseStats).toMatchObject({ fullParses: 1, reused: 0 })
    await flushSessionParseCachePersist()

    simulateRestart(cacheFile)
    const reusedStats = createSessionParseStats()
    expect(
      (await parseSessionCandidate(candidate, { ...context, parseStats: reusedStats })).issue
    ).toMatchObject({ messageCode: 'transcriptTooLarge' })
    expect(reusedStats).toMatchObject({ reused: 1, fullParses: 0, bytesRead: 0 })
  })

  it('imports the old JSON file even when a title lookup reaches the database first', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    const transcript = await writeTranscript(root)
    const candidate = await claudeCandidate(transcript)
    const session = await parseAgentSessionFileCached(candidate, process.platform)
    const legacyRow = {
      mtimeMs: candidate.file.mtimeMs,
      sizeBytes: candidate.file.sizeBytes,
      platform: process.platform,
      session
    }
    await writeFile(
      cacheFile,
      JSON.stringify({
        schemaVersion: SESSION_PARSE_CACHE_SCHEMA_VERSION,
        appVersion: 'old',
        entries: [[transcript, legacyRow]]
      })
    )
    const orphan = join(root, 'session-parse-cache-12345-99.tmp')
    await writeFile(orphan, '{"half":"written')

    simulateRestart(cacheFile)
    // Title synchronization can parse before the first History scan.
    await parse(await writeTranscript(root, 'baaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'))
    await flushSessionParseCachePersist()
    expect(existsSync(cacheFile)).toBe(false)
    expect(existsSync(orphan)).toBe(false)
    await rm(transcript)
    const stats = createSessionParseStats()
    expect(await parseAgentSessionFileCached(candidate, process.platform, stats)).toEqual(session)
    expect(stats).toMatchObject({ reused: 1, fullParses: 0 })
  })

  it('discards an old JSON file from another schema version', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    const transcript = await writeTranscript(root)
    const candidate = await claudeCandidate(transcript)
    await writeFile(
      cacheFile,
      JSON.stringify({
        schemaVersion: SESSION_PARSE_CACHE_SCHEMA_VERSION - 1,
        appVersion: 'old',
        entries: [
          [
            transcript,
            {
              mtimeMs: candidate.file.mtimeMs,
              sizeBytes: candidate.file.sizeBytes,
              platform: process.platform,
              session: null
            }
          ]
        ]
      })
    )
    simulateRestart(cacheFile)
    expect((await parse(transcript)).fullParses).toBe(1)
    expect(existsSync(cacheFile)).toBe(false)
  })

  it('performs zero disk IO when only configured, as Electron main is', async () => {
    const root = await makeTempDir()
    configureSessionParseCachePersistence({
      filePath: join(root, 'session-parse-cache.json'),
      appVersion: APP_VERSION
    })
    vi.clearAllMocks()
    invalidateSessionParseCacheEntry(join(root, 'deleted.jsonl'))
    await flushSessionParseCachePersist()
    expect(fsPromises.readFile).not.toHaveBeenCalled()
    expect(fsPromises.readdir).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
  })
})
