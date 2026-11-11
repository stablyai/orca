import { existsSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
import { scanAiVaultSessions } from '../session-scanner'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  type SessionParseStats
} from './session-scanner-parse-cache'
import {
  invalidateSessionParseCacheEntry,
  resetSessionParseCacheForTests,
  storeSessionScopeCwd,
  type SessionScopeCwdStamp
} from './session-parse-cache-store'
import type * as ParseCacheModule from './session-scanner-parse-cache'
import { isolatedScanRoots } from '../session-scanner-test-fixtures'
import { parseClaudeSessionFile } from '../scanners/claude/session-scanner-primary-parsers'
import { parseSessionCandidate } from '../session-scanner-candidate-parse'
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from '../transcripts/session-transcript-record-budget'
import type { FileWithMtime, SessionFileCandidate } from '../session-scanner-types'
import { sessionParseCacheDatabasePath } from './session-parse-cache-version-files'

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
const DAY_MS = 24 * 60 * 60_000

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

function databaseRows(cacheFile: string): { path: string; seen_at: number }[] {
  const db = new SyncDatabase(sessionParseCacheDatabasePath(dirname(cacheFile)))
  try {
    return db
      .prepare('SELECT path, seen_at FROM rows ORDER BY path')
      .all()
      .map((row) => ({ path: String(row.path), seen_at: Number(row.seen_at) }))
  } finally {
    db.close()
  }
}

function setSeenAt(cacheFile: string, path: string, seenAt: number): void {
  const db = new SyncDatabase(sessionParseCacheDatabasePath(dirname(cacheFile)))
  db.prepare('UPDATE rows SET seen_at = ? WHERE path = ?').run(seenAt, path)
  db.close()
}

describe('session parse cache persistence', () => {
  it('persists scope rows across chunks and keeps replacements queued during a yield', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const paths = Array.from({ length: 1_001 }, (_, index) => join(root, `session-${index}`))
    const stamp: SessionScopeCwdStamp = {
      mtimeMs: 1,
      sizeBytes: 10,
      platform: 'linux',
      cwd: '/original'
    }
    for (const path of paths) {
      storeSessionScopeCwd(path, stamp)
    }
    const flushing = flushSessionParseCachePersist()
    const replacement = { ...stamp, mtimeMs: 2, cwd: '/updated' }
    storeSessionScopeCwd(paths[0]!, replacement)
    storeSessionScopeCwd(paths[750]!, replacement)
    await flushing
    resetSessionParseCachePersistenceForTests()
    resetSessionParseCacheForTests()

    const database = new SessionParseCacheDatabase(sessionParseCacheDatabasePath(root))
    try {
      const stored = database.readScopeCwds(paths).found
      expect(stored.size).toBe(paths.length)
      for (const [index, path] of paths.entries()) {
        expect(stored.get(path)?.read).toEqual(index === 0 || index === 750 ? replacement : stamp)
      }
    } finally {
      database.close()
    }
  })

  it('round-trips: a persisted entry is a reused hit after a restart, without reading the transcript', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'vault-state', 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = await writeTranscript(root)
    const candidate = await claudeCandidate(transcript)
    const stats = createSessionParseStats()
    const first = await parseAgentSessionFileCached(candidate, process.platform, stats)
    expect(stats.fullParses).toBe(1)
    await flushSessionParseCachePersist()

    simulateRestart(cacheFile)
    // Removing the transcript proves the restored hit needs no transcript read.
    await rm(transcript)
    const reusedStats = createSessionParseStats()
    const reused = await parseAgentSessionFileCached(candidate, process.platform, reusedStats)
    expect(reusedStats).toMatchObject({ reused: 1, fullParses: 0, incremental: 0, bytesRead: 0 })
    expect(reused).toEqual(first)
  })

  it('keeps its rows while builds on other schema versions share the folder, and prunes all but one of theirs not in use', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = await writeTranscript(root)
    await parse(transcript)
    await flushSessionParseCachePersist()
    resetSessionParseCachePersistenceForTests()
    // A pre-versioning build replaces its file with its own schema on start; two older ones were used before it.
    const otherBuild = (name: string, version: number, usedAt: number) => {
      const db = new SyncDatabase(join(root, name))
      db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      db.prepare("INSERT INTO meta VALUES ('schema_version', ?)").run(String(version))
      db.close()
      return utimes(join(root, name), usedAt, usedAt)
    }
    await rm(join(root, 'session-parse-cache.sqlite'), { force: true })
    await otherBuild('session-parse-cache.sqlite', 8, 3_000)
    await otherBuild('session-parse-cache.v7.sqlite', 7, 2_000)
    await otherBuild('session-parse-cache.v6.sqlite', 6, 1_000)
    await otherBuild('session-parse-cache.v5.sqlite', 5, 500)
    const running = new SyncDatabase(join(root, 'session-parse-cache.v5.sqlite'))
    running.pragma('journal_mode = WAL')
    running.prepare('SELECT * FROM meta').all()
    // Still open, yet the least recently written: only the open check keeps it.
    for (const suffix of ['', '-wal']) {
      await utimes(join(root, `session-parse-cache.v5.sqlite${suffix}`), 500, 500)
    }

    try {
      simulateRestart(cacheFile)
      expect(await parse(transcript)).toMatchObject({ reused: 1, fullParses: 0 })
      expect((await readdir(root)).filter((name) => name.endsWith('.sqlite')).sort()).toEqual(
        [
          'session-parse-cache.sqlite',
          'session-parse-cache.v5.sqlite',
          `session-parse-cache.v${SESSION_PARSE_CACHE_SCHEMA_VERSION}.sqlite`
        ].sort()
      )
    } finally {
      running.close()
    }
  })

  it('adopts a pre-versioning file on this schema without disturbing a build still using it', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    const transcript = await writeTranscript(root)
    const candidate = await claudeCandidate(transcript)
    const session = await parseAgentSessionFileCached(candidate, process.platform)
    const unversioned = new SessionParseCacheDatabase(join(root, 'session-parse-cache.sqlite'))
    unversioned.write(
      [
        [
          transcript,
          {
            mtimeMs: candidate.file.mtimeMs,
            sizeBytes: candidate.file.sizeBytes ?? null,
            platform: process.platform,
            session
          }
        ]
      ],
      // ast-grep-ignore: test-no-wall-clock -- Real database expiry uses current time for persisted row ages.
      Date.now()
    )

    try {
      simulateRestart(cacheFile)
      expect(await parse(transcript)).toMatchObject({ reused: 1, fullParses: 0 })
      expect(unversioned.read(transcript)).toBeDefined()
    } finally {
      unversioned.close()
    }
  })

  it('scanAiVaultSessions reads the database and writes after parsing', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const roots = isolatedScanRoots(root)
    const transcript = join(roots.claudeProjectsDir, 'project', 'scan-session.jsonl')
    await mkdir(join(roots.claudeProjectsDir, 'project'), { recursive: true })
    await writeFile(
      transcript,
      `${userRecord(0, 'persisted-scan-marker-AAAA')}\n${assistantRecord(1, 'answer')}\n`
    )
    const pinnedMtime = new Date(1740000000000)
    await utimes(transcript, pinnedMtime, pinnedMtime)

    const first = await scanAiVaultSessions(roots)
    expect(JSON.stringify(first.sessions[0])).toContain('persisted-scan-marker-AAAA')
    await flushSessionParseCachePersist()

    simulateRestart(cacheFile)
    // Same size and mtime but different content distinguishes a persisted hit from a cold parse.
    await writeFile(
      transcript,
      `${userRecord(0, 'persisted-scan-marker-BBBB')}\n${assistantRecord(1, 'answer')}\n`
    )
    await utimes(transcript, pinnedMtime, pinnedMtime)
    const second = await scanAiVaultSessions(roots)
    expect(second.sessions[0]).toEqual(first.sessions[0])
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
    const oldDatabase = new SyncDatabase(sessionParseCacheDatabasePath(root))
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

  it('falls through to a full parse when a file changed while the app was closed', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = await writeTranscript(root)
    await parse(transcript)
    await flushSessionParseCachePersist()

    simulateRestart(cacheFile)
    // Restored rows lack incremental state; changed transcripts need a full parse.
    await appendFile(transcript, `${userRecord(2, 'follow-up')}\n${assistantRecord(3, 'more')}\n`)
    const stats = createSessionParseStats()
    const reparsed = await parseAgentSessionFileCached(
      await claudeCandidate(transcript),
      process.platform,
      stats
    )
    expect(stats).toMatchObject({ fullParses: 1, incremental: 0, reused: 0 })
    expect(reparsed).toEqual(await parseClaudeSessionFile((await claudeCandidate(transcript)).file))
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

  it('rebuilds a corrupt database instead of failing the scan', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    await writeFile(sessionParseCacheDatabasePath(root), 'not a database at all'.repeat(512))
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = await writeTranscript(root)
    expect((await parse(transcript)).fullParses).toBe(1)
    await flushSessionParseCachePersist()

    simulateRestart(cacheFile)
    expect((await parse(transcript)).reused).toBe(1)
  })

  it('drops rows whose transcript is gone and keeps old rows whose transcript is still there', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const kept = await writeTranscript(root, 'kaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    const deletedOutsideOrca = await writeTranscript(root, 'daaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    await parse(kept)
    await parse(deletedOutsideOrca)
    await flushSessionParseCachePersist()
    resetSessionParseCachePersistenceForTests()
    // ast-grep-ignore: test-no-wall-clock -- Real database expiry uses current time for persisted row ages.
    setSeenAt(cacheFile, kept, Date.now() - 31 * DAY_MS)
    // ast-grep-ignore: test-no-wall-clock -- Real database expiry uses current time for persisted row ages.
    setSeenAt(cacheFile, deletedOutsideOrca, Date.now() - 31 * DAY_MS)
    await rm(deletedOutsideOrca)

    simulateRestart(cacheFile)
    expect((await parse(kept)).reused).toBe(1)
    await vi.waitFor(() => expect(databaseRows(cacheFile).map((row) => row.path)).toEqual([kept]))
    await vi.waitFor(() =>
      // ast-grep-ignore: test-no-wall-clock -- Real database expiry uses current time for persisted row ages.
      expect(databaseRows(cacheFile)[0]!.seen_at).toBeGreaterThan(Date.now() - DAY_MS)
    )
  })

  it('invalidating before the first lookup does not bring the row back', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = await writeTranscript(root)
    await parse(transcript)
    await flushSessionParseCachePersist()

    simulateRestart(cacheFile)
    invalidateSessionParseCacheEntry(transcript)
    expect((await parse(transcript)).fullParses).toBe(1)
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

  it('swallows database failures and leaves scan results unaffected', async () => {
    const root = await makeTempDir()
    // A file blocking the cache directory fails on Windows and as root, unlike chmod-based fixtures.
    const blocker = join(root, 'blocker')
    await writeFile(blocker, 'a file, not a directory')
    initSessionParseCachePersistence({
      filePath: join(blocker, 'session-parse-cache.json'),
      appVersion: APP_VERSION
    })
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const transcript = await writeTranscript(root)
    expect((await parse(transcript)).fullParses).toBe(1)
    await expect(flushSessionParseCachePersist()).resolves.toBeUndefined()
    expect(debugSpy).toHaveBeenCalled()
    expect((await parse(transcript)).reused).toBe(1)
  })
})
