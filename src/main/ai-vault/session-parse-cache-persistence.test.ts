import { existsSync } from 'node:fs'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  truncate,
  utimes,
  writeFile
} from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  ensureSessionParseCacheLoaded,
  flushSessionParseCachePersistForTests,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests,
  scheduleSessionParseCachePersist,
  serializeSessionParseCacheSnapshot,
  SESSION_PARSE_CACHE_JSON_LIMITS,
  SESSION_PARSE_CACHE_MAX_BYTES
} from './session-parse-cache-persistence'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { serializeSessionParseCacheSnapshotCooperatively } from './session-parse-cache-snapshot-serialization'
import { scanAiVaultSessions } from './session-scanner'
import {
  createSessionParseStats,
  MAX_CACHE_ENTRIES,
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
let activeDebugSpy: MockInstance | null = null
let activeFileHandleSyncSpy: MockInstance | null = null

// Restored from a hook, not inline: a failed assertion must not leave
// console.debug stubbed for every later test in the file.
function silenceDebugLogs(): MockInstance {
  activeDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
  return activeDebugSpy
}

beforeEach(() => {
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
})

afterEach(async () => {
  activeDebugSpy?.mockRestore()
  activeDebugSpy = null
  activeFileHandleSyncSpy?.mockRestore()
  activeFileHandleSyncSpy = null
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

function nestedUnknownSession(depth: number): PersistedSessionParseCacheEntry['session'] {
  let value: unknown = null
  for (let index = 0; index < depth; index += 1) {
    value = { next: value }
  }
  return value as PersistedSessionParseCacheEntry['session']
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
    const debugSpy = silenceDebugLogs()

    const transcript = await writeTranscript(root)
    const stats = await coldParseStats(transcript)
    expect(stats.fullParses).toBe(1)
    expect(stats.reused).toBe(0)
    expect(existsSync(cacheFile)).toBe(false)
    expect(debugSpy).toHaveBeenCalled()
  })

  it('rejects an oversized sparse cache before reading its contents', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    await writeFile(cacheFile, '')
    await truncate(cacheFile, SESSION_PARSE_CACHE_MAX_BYTES + 1)
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const debugSpy = silenceDebugLogs()

    const transcript = await writeTranscript(root)
    const stats = await coldParseStats(transcript)
    expect(stats.fullParses).toBe(1)
    expect(stats.reused).toBe(0)
    expect(existsSync(cacheFile)).toBe(false)
    expect(debugSpy).toHaveBeenCalled()
  })

  it('accepts an exact-byte-cap cache file', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    const transcript = await writeTranscript(root)
    const candidate = await claudeCandidate(transcript)
    const file = {
      schemaVersion: 1,
      appVersion: APP_VERSION,
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
      ],
      padding: ''
    }
    const base = JSON.stringify(file)
    file.padding = 'x'.repeat(SESSION_PARSE_CACHE_MAX_BYTES - Buffer.byteLength(base))
    const payload = JSON.stringify(file)
    expect(Buffer.byteLength(payload)).toBe(SESSION_PARSE_CACHE_MAX_BYTES)
    await writeFile(cacheFile, payload)
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })

    const stats = await coldParseStats(transcript)
    expect(stats.reused).toBe(1)
    expect(stats.fullParses).toBe(0)
  })

  it('rejects structurally excessive JSON before parsing the cache graph', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    const transcript = await writeTranscript(root)
    const candidate = await claudeCandidate(transcript)
    const structuralNoise = Array.from({ length: 1_000_000 }, () => null)
    await writeFile(
      cacheFile,
      JSON.stringify({
        schemaVersion: 1,
        appVersion: APP_VERSION,
        entries: [
          [
            transcript,
            {
              mtimeMs: candidate.file.mtimeMs,
              sizeBytes: candidate.file.sizeBytes,
              platform: process.platform,
              session: { structuralNoise }
            }
          ]
        ]
      })
    )
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const debugSpy = silenceDebugLogs()

    const stats = await coldParseStats(transcript)
    expect(stats.fullParses).toBe(1)
    expect(stats.reused).toBe(0)
    expect(existsSync(cacheFile)).toBe(false)
    expect(debugSpy).toHaveBeenCalled()
  })

  it('accepts nesting depth 32 and rejects depth 33 through the real loader', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    const transcript = await writeTranscript(root)
    const candidate = await claudeCandidate(transcript)
    const writeNestedCache = async (sessionDepth: number): Promise<void> => {
      await writeFile(
        cacheFile,
        JSON.stringify({
          schemaVersion: 1,
          appVersion: APP_VERSION,
          entries: [
            [
              transcript,
              {
                mtimeMs: candidate.file.mtimeMs,
                sizeBytes: candidate.file.sizeBytes,
                platform: process.platform,
                session: nestedUnknownSession(sessionDepth)
              }
            ]
          ]
        })
      )
    }

    // The persisted wrapper (file object → entries → entry pair → entry
    // object) already spends 4 of the budget before the session value starts.
    const maxSessionDepth = SESSION_PARSE_CACHE_JSON_LIMITS.nestingDepth - 4

    await writeNestedCache(maxSessionDepth)
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    expect((await coldParseStats(transcript)).reused).toBe(1)

    simulateRestart(cacheFile)
    await writeNestedCache(maxSessionDepth + 1)
    const rejectedStats = await coldParseStats(transcript)
    expect(rejectedStats.reused).toBe(0)
    expect(rejectedStats.fullParses).toBe(1)
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

  it('syncs a complete temp snapshot before its atomic rename', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = await writeTranscript(root)
    const stats = await coldParseStats(transcript)
    const probe = await fsPromises.open(join(root, 'file-handle-probe'), 'w')
    activeFileHandleSyncSpy = vi.spyOn(Object.getPrototypeOf(probe), 'sync')
    await probe.close()
    vi.clearAllMocks()

    scheduleSessionParseCachePersist(stats)
    await flushSessionParseCachePersistForTests()

    expect(activeFileHandleSyncSpy).toHaveBeenCalledTimes(1)
    expect(fsPromises.rename).toHaveBeenCalledTimes(1)
    expect(activeFileHandleSyncSpy.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fsPromises.rename).mock.invocationCallOrder[0]!
    )
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

  it('trims a large writer snapshot to the synchronous parse budget and keeps its newest entry', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    const transcript = await writeTranscript(root)
    const candidate = await claudeCandidate(transcript)
    const largeSession = {
      padding: 'x'.repeat(4_000)
    } as unknown as PersistedSessionParseCacheEntry['session']
    const entry: PersistedSessionParseCacheEntry = {
      mtimeMs: candidate.file.mtimeMs,
      sizeBytes: candidate.file.sizeBytes ?? null,
      platform: process.platform,
      session: largeSession
    }
    seedSessionParseCache([
      ...Array.from({ length: 4095 }, (_, index): [string, PersistedSessionParseCacheEntry] => [
        `/fake-${index}`,
        entry
      ]),
      [transcript, entry]
    ])
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    scheduleSessionParseCachePersist({
      reused: 0,
      incremental: 0,
      fullParses: 1,
      bytesRead: 1
    })
    await flushSessionParseCachePersistForTests()

    simulateRestart(cacheFile)
    await ensureSessionParseCacheLoaded()
    const stats = createSessionParseStats()
    await parseAgentSessionFileCached(candidate, process.platform, stats)
    expect(stats.reused).toBe(1)
    const persistedText = await readFile(cacheFile, 'utf8')
    expect(Buffer.byteLength(persistedText)).toBeLessThanOrEqual(SESSION_PARSE_CACHE_MAX_BYTES)
    const persisted = JSON.parse(persistedText) as { entries: unknown[] }
    expect(persisted.entries.length).toBeGreaterThan(0)
    expect(persisted.entries.length).toBeLessThan(4096)
  })

  it('rejects malformed entries even when they fall outside the retained tail', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    const transcript = await writeTranscript(root)
    const candidate = await claudeCandidate(transcript)
    const validEntry: PersistedSessionParseCacheEntry = {
      mtimeMs: candidate.file.mtimeMs,
      sizeBytes: candidate.file.sizeBytes ?? null,
      platform: process.platform,
      session: null
    }
    const entries: unknown[] = [
      ['discarded-malformed'],
      ...Array.from({ length: 4097 }, (_, index) => [`/fake-${index}`, validEntry]),
      [transcript, validEntry],
      [transcript, { ...validEntry, mtimeMs: candidate.file.mtimeMs + 1 }]
    ]
    await writeFile(
      cacheFile,
      JSON.stringify({ schemaVersion: 1, appVersion: APP_VERSION, entries })
    )
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })

    const stats = await coldParseStats(transcript)
    expect(stats.fullParses).toBe(1)
    expect(stats.reused).toBe(0)
  })

  it('keeps the newest persisted entry when a path is duplicated', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    const transcript = await writeTranscript(root)
    const candidate = await claudeCandidate(transcript)
    const entry: PersistedSessionParseCacheEntry = {
      mtimeMs: candidate.file.mtimeMs,
      sizeBytes: candidate.file.sizeBytes ?? null,
      platform: process.platform,
      session: null
    }
    await writeFile(
      cacheFile,
      JSON.stringify({
        schemaVersion: 1,
        appVersion: APP_VERSION,
        entries: [
          [transcript, { ...entry, mtimeMs: entry.mtimeMs - 1 }],
          [transcript, entry]
        ]
      })
    )
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })

    const stats = await coldParseStats(transcript)
    expect(stats.reused).toBe(1)
    expect(stats.fullParses).toBe(0)
  })

  it('leaves the previous snapshot intact when writer structure admission fails', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = await writeTranscript(root)
    await parseAndPersist(transcript)
    const previousSnapshot = await readFile(cacheFile, 'utf8')

    let deeplyNested: unknown = null
    for (let depth = 0; depth < 40; depth += 1) {
      deeplyNested = { next: deeplyNested }
    }
    seedSessionParseCache([
      [
        '/foreign/deep-session.jsonl',
        {
          mtimeMs: 1,
          sizeBytes: 1,
          platform: process.platform,
          session: deeplyNested as PersistedSessionParseCacheEntry['session']
        }
      ]
    ])
    const debugSpy = silenceDebugLogs()
    scheduleSessionParseCachePersist({
      reused: 0,
      incremental: 0,
      fullParses: 1,
      bytesRead: 1
    })
    await flushSessionParseCachePersistForTests()

    expect(await readFile(cacheFile, 'utf8')).toBe(previousSnapshot)
    expect(debugSpy).toHaveBeenCalled()
  })

  // Why: hitting the cap must degrade, not disable. Giving up outright would
  // leave the stale file in place and every later save failing identically,
  // silently turning the #9210 cache off for the rest of the install's life.
  it('trims the oldest entries rather than abandoning an oversized snapshot', () => {
    const entries: [string, PersistedSessionParseCacheEntry][] = Array.from(
      { length: 16 },
      (_, index) => [
        `/foreign/entry-${index}.jsonl`,
        { mtimeMs: index, sizeBytes: 1, platform: process.platform, session: null }
      ]
    )

    // A cap that only a subset can fit under.
    const serialized = serializeSessionParseCacheSnapshot(entries, APP_VERSION, 512)
    expect(serialized).not.toBeNull()

    const saved = JSON.parse(serialized!) as {
      entries: [string, PersistedSessionParseCacheEntry][]
    }
    expect(saved.entries.length).toBeGreaterThan(0)
    expect(saved.entries.length).toBeLessThan(entries.length)
    // Snapshot order is oldest→newest, and a restart only reuses the newest.
    expect(saved.entries.at(-1)?.[0]).toBe('/foreign/entry-15.jsonl')
  })

  it('retains the maximum fitting suffix instead of dropping half for a tiny overflow', () => {
    const entries: [string, PersistedSessionParseCacheEntry][] = Array.from(
      { length: 16 },
      (_, index) => [
        `/foreign/entry-${index}.jsonl`,
        { mtimeMs: index, sizeBytes: 1, platform: process.platform, session: null }
      ]
    )
    const full = serializeSessionParseCacheSnapshot(entries, APP_VERSION)
    expect(full).not.toBeNull()

    const serialized = serializeSessionParseCacheSnapshot(
      entries,
      APP_VERSION,
      Buffer.byteLength(full!) - 1
    )
    const saved = JSON.parse(serialized!) as {
      entries: [string, PersistedSessionParseCacheEntry][]
    }
    expect(saved.entries).toHaveLength(15)
    expect(saved.entries[0]?.[0]).toBe('/foreign/entry-1.jsonl')
    expect(saved.entries.at(-1)?.[0]).toBe('/foreign/entry-15.jsonl')
  })

  it('cooperatively matches synchronous admission and precise trimming', async () => {
    const entries: [string, PersistedSessionParseCacheEntry][] = Array.from(
      { length: 64 },
      (_, index) => [
        `/foreign/entry-${index}.jsonl`,
        { mtimeMs: index, sizeBytes: 1, platform: process.platform, session: null }
      ]
    )

    const full = serializeSessionParseCacheSnapshot(entries, APP_VERSION)
    expect(full).not.toBeNull()
    const maxBytes = Buffer.byteLength(full!) - 1
    await expect(
      serializeSessionParseCacheSnapshotCooperatively(entries, APP_VERSION, maxBytes)
    ).resolves.toBe(serializeSessionParseCacheSnapshot(entries, APP_VERSION, maxBytes))
  })

  // Writer and loader enforce the same limits; pin enough headroom for the
  // widest realistic full cache so capacity trimming stays exceptional.
  it('keeps a full snapshot loadable within the load-path limits', () => {
    const entries: [string, PersistedSessionParseCacheEntry][] = Array.from(
      { length: MAX_CACHE_ENTRIES },
      (_, index) => [
        `/Users/someone/.claude/projects/a-fairly-long-project-dir/session-${index}.jsonl`,
        {
          mtimeMs: 1_700_000_000_000 + index,
          sizeBytes: 4096,
          platform: process.platform,
          session: {
            id: `local:claude:session-${index}:/path/session-${index}.jsonl`,
            executionHostId: 'local',
            agent: 'claude',
            sessionId: `session-${index}`,
            title: 't'.repeat(96),
            cwd: '/Users/someone/Documents/projects/orca/a-worktree',
            branch: 'some-fairly-long-branch-name',
            model: 'claude-opus-5',
            filePath: `/path/session-${index}.jsonl`,
            codexHome: null,
            createdAt: '2026-07-20T00:00:00.000Z',
            updatedAt: '2026-07-26T00:00:00.000Z',
            modifiedAt: '2026-07-26T00:00:00.000Z',
            messageCount: 500,
            totalTokens: 1_000_000,
            // The accumulator's ring buffer caps previews at 5 × 220 chars.
            previewMessages: Array.from({ length: 5 }, () => ({
              role: 'user' as const,
              text: 'p'.repeat(220),
              timestamp: '2026-07-26T00:00:00.000Z'
            })),
            lastUserPrompt: 'q'.repeat(500),
            queuedMessageCount: 0,
            subagentTranscriptCount: 4,
            resumeCommand: `claude --resume session-${index}`,
            subagent: null
          }
        }
      ]
    )

    const serialized = serializeSessionParseCacheSnapshot(entries, APP_VERSION)
    expect(serialized).not.toBeNull()
    expect(Buffer.byteLength(serialized!, 'utf8')).toBeLessThan(SESSION_PARSE_CACHE_MAX_BYTES)
    expect(() =>
      assertJsonTextStructureWithinLimits(serialized!, SESSION_PARSE_CACHE_JSON_LIMITS)
    ).not.toThrow()
  })

  it('reports rather than writes when no subset of entries can fit', () => {
    const debugSpy = silenceDebugLogs()
    // One poison entry, so trimming can never produce a fitting snapshot.
    const serialized = serializeSessionParseCacheSnapshot(
      [
        [
          '/foreign/huge.jsonl',
          { mtimeMs: 1, sizeBytes: 1, platform: process.platform, session: null }
        ]
      ],
      APP_VERSION,
      8
    )
    expect(serialized).toBeNull()
    expect(debugSpy).toHaveBeenCalled()
  })

  it('leaves the previous snapshot intact when writer byte admission fails', async () => {
    const root = await makeTempDir()
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: APP_VERSION })
    const transcript = await writeTranscript(root)
    await parseAndPersist(transcript)
    const previousSnapshot = await readFile(cacheFile, 'utf8')

    seedSessionParseCache([
      [
        'x'.repeat(SESSION_PARSE_CACHE_MAX_BYTES),
        {
          mtimeMs: 1,
          sizeBytes: 1,
          platform: process.platform,
          session: null
        }
      ]
    ])
    const debugSpy = silenceDebugLogs()
    scheduleSessionParseCachePersist({
      reused: 0,
      incremental: 0,
      fullParses: 1,
      bytesRead: 1
    })
    await flushSessionParseCachePersistForTests()

    expect(await readFile(cacheFile, 'utf8')).toBe(previousSnapshot)
    expect(debugSpy).toHaveBeenCalled()
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
    const debugSpy = silenceDebugLogs()
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
    const debugSpy = silenceDebugLogs()

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
  })
})
