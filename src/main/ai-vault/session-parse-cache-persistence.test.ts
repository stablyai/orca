import { existsSync } from 'node:fs'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureSessionParseCacheLoaded,
  flushSessionParseCachePersistForTests,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests,
  scheduleSessionParseCachePersist
} from './session-parse-cache-persistence'
import { scanAiVaultSessions } from './session-scanner'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests,
  seedSessionParseCache,
  type PersistedSessionParseCacheEntry,
  type SessionParseStats
} from './session-scanner-parse-cache'
import { isolatedScanRoots } from './session-scanner-test-fixtures'
import { parseClaudeSessionFile } from './session-scanner-primary-parsers'
import type { FileWithMtime, SessionFileCandidate } from './session-scanner-types'

// Spy-wrap (real implementations still run) so the zero-disk-IO test can
// assert the uninitialized module never touches the filesystem.
vi.mock('node:fs/promises', { spy: true })

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

async function writeTranscript(root: string): Promise<string> {
  const path = join(root, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
  await writeFile(path, `${userRecord(0, 'first question')}\n${assistantRecord(1, 'answer')}\n`)
  return path
}

async function parseAndPersist(path: string): Promise<SessionParseStats> {
  const stats = createSessionParseStats()
  await ensureSessionParseCacheLoaded()
  await parseAgentSessionFileCached(await claudeCandidate(path), process.platform, stats)
  scheduleSessionParseCachePersist(stats)
  await flushSessionParseCachePersistForTests()
  return stats
}

// Clear the in-memory cache and the persistence module's memoized state, then
// re-enable persistence against the same file — a fresh launch, same profile.
function simulateRestart(cacheFile: string, appVersion = APP_VERSION): void {
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
  initSessionParseCachePersistence({ filePath: cacheFile, appVersion })
}

async function coldParseStats(path: string): Promise<SessionParseStats> {
  const stats = createSessionParseStats()
  await ensureSessionParseCacheLoaded()
  await parseAgentSessionFileCached(await claudeCandidate(path), process.platform, stats)
  return stats
}

describe('session parse cache persistence', () => {
  it('round-trips: a persisted entry is a reused hit after a restart, without reading the transcript', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'vault-state', 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })

    const transcript = await writeTranscript(root)
    const candidate = await claudeCandidate(transcript)
    const stats = createSessionParseStats()
    await ensureSessionParseCacheLoaded()
    const first = await parseAgentSessionFileCached(candidate, process.platform, stats)
    expect(first).not.toBeNull()
    expect(stats.fullParses).toBe(1)

    scheduleSessionParseCachePersist(stats)
    await flushSessionParseCachePersistForTests()
    expect(existsSync(cacheFile)).toBe(true)

    simulateRestart(cacheFile)
    await ensureSessionParseCacheLoaded()

    // Deleting the transcript proves the hit needs no transcript read at all.
    await rm(transcript)
    const reusedStats = createSessionParseStats()
    const reused = await parseAgentSessionFileCached(candidate, process.platform, reusedStats)
    expect(reusedStats.reused).toBe(1)
    expect(reusedStats.fullParses).toBe(0)
    expect(reusedStats.incremental).toBe(0)
    expect(reusedStats.bytesRead).toBe(0)
    expect(reused).toEqual(first)
  })

  it('ignores a corrupt cache file and scans cold', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    await writeFile(cacheFile, 'not json {{{')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })

    const transcript = await writeTranscript(root)
    const stats = await coldParseStats(transcript)
    expect(stats.fullParses).toBe(1)
    expect(stats.reused).toBe(0)
  })

  it('ignores a cache file with a mismatched schemaVersion', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = await writeTranscript(root)
    await parseAndPersist(transcript)

    const persisted = JSON.parse(await readFile(cacheFile, 'utf-8'))
    persisted.schemaVersion = 999
    await writeFile(cacheFile, JSON.stringify(persisted))

    simulateRestart(cacheFile)
    const stats = await coldParseStats(transcript)
    expect(stats.fullParses).toBe(1)
    expect(stats.reused).toBe(0)
  })

  it('ignores a cache file written by a different app version', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = await writeTranscript(root)
    await parseAndPersist(transcript)

    simulateRestart(cacheFile, '9.9.9-other')
    const stats = await coldParseStats(transcript)
    expect(stats.fullParses).toBe(1)
    expect(stats.reused).toBe(0)
  })

  it('seeding never clobbers a live in-memory entry', async () => {
    const root = await makeTempDir()
    const transcript = await writeTranscript(root)
    const candidate = await claudeCandidate(transcript)
    const live = await parseAgentSessionFileCached(candidate, process.platform)
    expect(live).not.toBeNull()

    // A stale persisted entry for the same path (session: null marker).
    seedSessionParseCache([
      [
        transcript,
        {
          mtimeMs: candidate.file.mtimeMs,
          sizeBytes: candidate.file.sizeBytes ?? null,
          platform: process.platform,
          session: null
        }
      ]
    ])

    const stats = createSessionParseStats()
    const after = await parseAgentSessionFileCached(candidate, process.platform, stats)
    expect(stats.reused).toBe(1)
    expect(after).toBe(live)
  })

  it('falls through to a full parse when a seeded file changed while the app was closed', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = await writeTranscript(root)
    await parseAndPersist(transcript)

    simulateRestart(cacheFile)
    await ensureSessionParseCacheLoaded()

    // Grown while "closed": seeded entries have no resume state, so this is a
    // full parse (not incremental) whose result matches a cold parse.
    await appendFile(transcript, `${userRecord(2, 'follow-up')}\n${assistantRecord(3, 'more')}\n`)
    const stats = createSessionParseStats()
    const reparsed = await parseAgentSessionFileCached(
      await claudeCandidate(transcript),
      process.platform,
      stats
    )
    expect(stats.fullParses).toBe(1)
    expect(stats.incremental).toBe(0)
    expect(stats.reused).toBe(0)
    expect(reparsed).toEqual(await parseClaudeSessionFile((await claudeCandidate(transcript)).file))
    expect(reparsed?.messageCount).toBe(4)
  })

  it('performs zero disk IO when never initialized', async () => {
    vi.clearAllMocks()

    await ensureSessionParseCacheLoaded()
    scheduleSessionParseCachePersist({ reused: 0, incremental: 2, fullParses: 5, bytesRead: 10 })
    await flushSessionParseCachePersistForTests()

    expect(fsPromises.readFile).not.toHaveBeenCalled()
    expect(fsPromises.writeFile).not.toHaveBeenCalled()
    expect(fsPromises.mkdir).not.toHaveBeenCalled()
    expect(fsPromises.rename).not.toHaveBeenCalled()
    expect(fsPromises.rm).not.toHaveBeenCalled()
  })

  it('collapses back-to-back schedules into one write', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = await writeTranscript(root)
    const stats = await coldParseStats(transcript)

    vi.clearAllMocks()
    scheduleSessionParseCachePersist(stats)
    scheduleSessionParseCachePersist(stats)
    await flushSessionParseCachePersistForTests()

    expect(fsPromises.rename).toHaveBeenCalledTimes(1)
    expect(existsSync(cacheFile)).toBe(true)
  })

  it('sweeps orphaned temp files from a prior crashed save on load', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    const orphan = join(root, 'session-parse-cache-12345-99.tmp')
    await writeFile(orphan, '{"half":"written')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })

    await ensureSessionParseCacheLoaded()
    expect(existsSync(orphan)).toBe(false)
  })

  it('scanAiVaultSessions seeds from the persisted cache and persists after parsing', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const roots = isolatedScanRoots(root)
    const transcript = join(roots.claudeProjectsDir, 'project', 'scan-session.jsonl')
    await mkdir(join(roots.claudeProjectsDir, 'project'), { recursive: true })
    // Same-length markers so the rewrite below preserves sizeBytes exactly.
    await writeFile(
      transcript,
      `${userRecord(0, 'persisted-scan-marker-AAAA')}\n${assistantRecord(1, 'answer')}\n`
    )
    const pinnedMtime = new Date(1740000000000)
    await utimes(transcript, pinnedMtime, pinnedMtime)

    const first = await scanAiVaultSessions(roots)
    expect(first.sessions).toHaveLength(1)
    expect(JSON.stringify(first.sessions[0])).toContain('persisted-scan-marker-AAAA')
    // The scan itself (not a manual schedule call) must have queued the save.
    await flushSessionParseCachePersistForTests()
    expect(existsSync(cacheFile)).toBe(true)

    simulateRestart(cacheFile)
    // Rewrite with identical length and mtime: only a seeded cache hit can
    // still return the original marker; a cold re-parse would see BBBB.
    await writeFile(
      transcript,
      `${userRecord(0, 'persisted-scan-marker-BBBB')}\n${assistantRecord(1, 'answer')}\n`
    )
    await utimes(transcript, pinnedMtime, pinnedMtime)

    const second = await scanAiVaultSessions(roots)
    expect(second.sessions).toHaveLength(1)
    expect(JSON.stringify(second.sessions[0])).toContain('persisted-scan-marker-AAAA')
    expect(second.sessions[0]).toEqual(first.sessions[0])
  })

  it('an over-cap seed list keeps the newest tail of the snapshot order', async () => {
    const root = await makeTempDir()
    const transcript = await writeTranscript(root)
    const candidate = await claudeCandidate(transcript)
    // Snapshot order is oldest→newest, so a foreign over-cap file must keep
    // its newest (last) entries; the real transcript rides at the very end.
    const fakes: [string, PersistedSessionParseCacheEntry][] = Array.from(
      { length: 4100 },
      (_, index): [string, PersistedSessionParseCacheEntry] => [
        `/nonexistent/fake-${index}.jsonl`,
        { mtimeMs: index, sizeBytes: 1, platform: process.platform, session: null }
      ]
    )
    seedSessionParseCache([
      ...fakes,
      [
        transcript,
        {
          mtimeMs: candidate.file.mtimeMs,
          sizeBytes: candidate.file.sizeBytes ?? null,
          platform: process.platform,
          session: null
        }
      ]
    ])

    const stats = createSessionParseStats()
    await parseAgentSessionFileCached(candidate, process.platform, stats)
    expect(stats.reused).toBe(1)
    expect(stats.fullParses).toBe(0)
  })

  it('a failing rename cleans up its temp file and keeps the previous snapshot usable', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = await writeTranscript(root)
    await parseAndPersist(transcript)
    const previousSnapshot = await readFile(cacheFile, 'utf-8')

    // A second session parsed after the good save; its save's rename is
    // rejected (the Windows EPERM/EBUSY story: target held open elsewhere).
    const other = join(root, 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
    await writeFile(other, `${userRecord(2, 'second session')}\n${assistantRecord(3, 'reply')}\n`)
    const stats = createSessionParseStats()
    await parseAgentSessionFileCached(await claudeCandidate(other), process.platform, stats)
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.mocked(fsPromises.rename).mockRejectedValueOnce(
      Object.assign(new Error('EPERM: rename blocked'), { code: 'EPERM' })
    )
    scheduleSessionParseCachePersist(stats)
    await expect(flushSessionParseCachePersistForTests()).resolves.toBeUndefined()
    expect(debugSpy).toHaveBeenCalled()

    // The temp file was written before the rename failed; it must not linger,
    // and the previous snapshot must be byte-identical (never torn).
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(await readFile(cacheFile, 'utf-8')).toBe(previousSnapshot)

    // That intact previous snapshot still round-trips on the next launch.
    simulateRestart(cacheFile)
    await ensureSessionParseCacheLoaded()
    const reusedStats = createSessionParseStats()
    await parseAgentSessionFileCached(
      await claudeCandidate(transcript),
      process.platform,
      reusedStats
    )
    expect(reusedStats.reused).toBe(1)
    debugSpy.mockRestore()
  })

  it('swallows save failures and leaves scan results unaffected', async () => {
    const root = await makeTempDir()
    // A regular file where the cache directory should be makes mkdir fail on
    // every platform (no chmod tricks, which don't hold on Windows or as root).
    const blocker = join(root, 'blocker')
    await writeFile(blocker, 'a file, not a directory')
    initSessionParseCachePersistence({
      filePath: join(blocker, 'session-parse-cache.json'),
      appVersion: APP_VERSION
    })
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})

    const transcript = await writeTranscript(root)
    const candidate = await claudeCandidate(transcript)
    const stats = createSessionParseStats()
    await ensureSessionParseCacheLoaded()
    const session = await parseAgentSessionFileCached(candidate, process.platform, stats)
    expect(session).not.toBeNull()

    scheduleSessionParseCachePersist(stats)
    await expect(flushSessionParseCachePersistForTests()).resolves.toBeUndefined()
    expect(debugSpy).toHaveBeenCalled()

    // The in-memory cache still serves hits and no partial files were left behind.
    const reusedStats = createSessionParseStats()
    expect(await parseAgentSessionFileCached(candidate, process.platform, reusedStats)).toBe(
      session
    )
    expect(reusedStats.reused).toBe(1)
    expect(await readdir(root)).toEqual(expect.arrayContaining(['blocker']))
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    debugSpy.mockRestore()
  })
})
