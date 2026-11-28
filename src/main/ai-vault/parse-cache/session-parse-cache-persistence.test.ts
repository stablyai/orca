import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import {
  flushSessionParseCachePersist,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests
} from './session-parse-cache-persistence'
import { SESSION_PARSE_CACHE_SCHEMA_VERSION } from './session-parse-cache-database'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  type SessionParseStats
} from './session-scanner-parse-cache'
import { resetSessionParseCacheForTests } from './session-parse-cache-store'
import { parseSessionCandidate } from '../parsing/session-scanner-candidate-parse'
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from '../transcripts/session-transcript-record-budget'
import type { FileWithMtime, SessionFileCandidate } from '../session-scanner-types'
import { sessionParseCacheDatabasePath } from './session-parse-cache-version-files'

const APP_VERSION = '1.2.3-test'

let tempRoots: string[] = []

beforeEach(() => {
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
})

afterEach(async () => {
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

  it('refreshes Droid model and token counts on sidecar-only settings updates without reparsing', async () => {
    const root = await makeTempDir()
    const transcript = join(root, 'droid-session.jsonl')
    const settings = join(root, 'droid-session.settings.json')
    await writeFile(
      transcript,
      `${JSON.stringify({ type: 'session_start', id: 'droid-1', title: 'Test', cwd: '/repo', timestamp: '2026-01-01T00:00:00.000Z' })}\n${JSON.stringify({ type: 'message', role: 'user', text: 'hello', timestamp: '2026-01-01T00:00:01.000Z' })}\n`
    )
    await writeFile(
      settings,
      JSON.stringify({
        model: 'claude-sonnet-4',
        tokenUsage: { inputTokens: 10, outputTokens: 20 }
      })
    )
    const buildDroidCandidate = async (): Promise<SessionFileCandidate> => {
      const [fileStat, sidecarStat] = await Promise.all([stat(transcript), stat(settings)])
      return {
        agent: 'droid',
        codexHome: null,
        file: {
          path: transcript,
          mtimeMs: fileStat.mtimeMs,
          modifiedAt: fileStat.mtime.toISOString(),
          sizeBytes: fileStat.size,
          sidecar: {
            path: settings,
            mtimeMs: sidecarStat.mtimeMs,
            sizeBytes: sidecarStat.size
          }
        }
      }
    }

    const firstStats = createSessionParseStats()
    const first = await parseAgentSessionFileCached(
      await buildDroidCandidate(),
      process.platform,
      firstStats
    )
    expect(first).toMatchObject({ model: 'claude-sonnet-4', totalTokens: 30 })
    expect(firstStats).toMatchObject({ fullParses: 1, reused: 0 })

    // Rewrite only the settings sidecar with a new model and token usage; transcript stays untouched.
    await writeFile(
      settings,
      JSON.stringify({
        model: 'claude-opus-4-6',
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 25,
          cacheReadTokens: 10
        }
      })
    )
    const updatedStats = createSessionParseStats()
    const updated = await parseAgentSessionFileCached(
      await buildDroidCandidate(),
      process.platform,
      updatedStats
    )
    expect(updated).toMatchObject({ model: 'claude-opus-4-6', totalTokens: 185 })
    expect(updatedStats).toMatchObject({ reused: 1, fullParses: 0, bytesRead: 0 })
  })
})
