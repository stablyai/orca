import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: the backfill's first await; failing it once is the cheapest way to make
// a whole pass throw without touching the transcripts on disk, and holding it
// is the one deterministic checkpoint before the backfill touches a file.
let failNextParseCacheLoad = false
let holdNextParseCacheLoad: Promise<void> | null = null
let parseCacheLoads = 0
vi.mock('../ai-vault/session-parse-cache-persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof ParseCachePersistence>()
  return {
    ...actual,
    ensureSessionParseCacheLoaded: async (): Promise<void> => {
      parseCacheLoads += 1
      if (failNextParseCacheLoad) {
        failNextParseCacheLoad = false
        throw new Error('parse cache unavailable')
      }
      const hold = holdNextParseCacheLoad
      holdNextParseCacheLoad = null
      await hold
      return actual.ensureSessionParseCacheLoaded()
    }
  }
})
// Why: a search's refresh pass enumerates with a finite per-agent limit and the
// backfill with an infinite one, so holding the finite call keeps one search
// provably in flight while the backfill is free to run.
let holdSearchRefresh: Promise<void> | null = null
vi.mock('../ai-vault/session-scanner-source-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof SourceDiscovery>()
  return {
    ...actual,
    discoverAiVaultSessionSources: async (
      args: Parameters<typeof actual.discoverAiVaultSessionSources>[0]
    ): ReturnType<typeof actual.discoverAiVaultSessionSources> => {
      if (Number.isFinite(args.limitPerAgent) && holdSearchRefresh) {
        await holdSearchRefresh
      }
      return actual.discoverAiVaultSessionSources(args)
    }
  }
})
import { getSessionSearchIndexSink } from '../ai-vault/session-search-capture'
import type * as ParseCachePersistence from '../ai-vault/session-parse-cache-persistence'
import type * as SourceDiscovery from '../ai-vault/session-scanner-source-discovery'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { isolatedScanRoots, jsonLines } from '../ai-vault/session-scanner-test-fixtures'
import { SessionSearchService, type SessionSearchScanRoots } from './session-search-service'

let tempRoots: string[] = []
let services: SessionSearchService[] = []

beforeEach(() => {
  resetSessionParseCacheForTests()
  holdSearchRefresh = null
  parseCacheLoads = 0
})

afterEach(async () => {
  for (const service of services) {
    service.dispose()
  }
  services = []
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeTempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-session-search-consent-'))
  tempRoots.push(root)
  return root
}

/** One Claude transcript, optionally back-dated so a history bound can exclude it. */
async function writeClaudeTranscript(
  roots: ReturnType<typeof isolatedScanRoots>,
  sessionId: string,
  text: string,
  ageDays = 0
): Promise<void> {
  const dir = join(roots.claudeProjectsDir, 'project')
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${sessionId}.jsonl`)
  await writeFile(
    filePath,
    jsonLines([
      {
        type: 'user',
        sessionId,
        timestamp: '2026-05-01T10:00:00.000Z',
        cwd: '/repo/app',
        gitBranch: 'main',
        message: { role: 'user', content: text }
      },
      {
        type: 'assistant',
        sessionId,
        timestamp: '2026-05-01T10:01:00.000Z',
        cwd: '/repo/app',
        gitBranch: 'main',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'opening the intake pump config' }]
        }
      }
    ])
  )
  if (ageDays > 0) {
    const when = new Date(Date.now() - ageDays * 86_400_000)
    await utimes(filePath, when, when)
  }
}

function makeService(
  databasePath: string,
  policy: { enabled: boolean; historyDays: number | null }
): SessionSearchService {
  const service = new SessionSearchService({ databasePath, ...policy })
  services.push(service)
  return service
}

async function scanRoots(): Promise<{
  roots: SessionSearchScanRoots & ReturnType<typeof isolatedScanRoots>
  databasePath: string
}> {
  const root = await makeTempDir()
  return {
    roots: { ...isolatedScanRoots(root), platform: 'darwin' },
    databasePath: join(root, 'index', 'index.sqlite')
  }
}

describe('SessionSearchService consent gate', () => {
  it('opens no database and registers no sink while search is disabled', async () => {
    const { roots, databasePath } = await scanRoots()
    await writeClaudeTranscript(roots, 'disabled-session', 'the vacuum quota never settles')

    const service = makeService(databasePath, { enabled: false, historyDays: null })
    const result = await service.search({ query: 'vacuum' }, roots)

    expect(existsSync(databasePath)).toBe(false)
    expect(getSessionSearchIndexSink()).toBeNull()
    expect(result.hits).toEqual([])
    expect(result.coverage.enabled).toBe(false)
    expect(result.coverage.backfill).toBe('idle')
  })

  it('never starts a backfill from a coverage read', async () => {
    const { roots, databasePath } = await scanRoots()
    await writeClaudeTranscript(roots, 'coverage-session', 'the vacuum quota never settles')

    const service = makeService(databasePath, { enabled: true, historyDays: null })
    const coverage = service.coverage()

    expect(coverage.backfill).toBe('idle')
    expect(coverage.sessionsIndexed).toBe(0)
  })

  it('indexes and answers once the user enables it at runtime', async () => {
    const { roots, databasePath } = await scanRoots()
    await writeClaudeTranscript(roots, 'enabled-session', 'the vacuum quota never settles')

    const service = makeService(databasePath, { enabled: false, historyDays: null })
    await service.configure({ enabled: true, historyDays: null }, roots)
    await service.ensureBackfill(roots)

    expect(getSessionSearchIndexSink()).not.toBeNull()
    const result = await service.search({ query: 'vacuum' }, roots)
    expect(result.coverage.enabled).toBe(true)
    expect(result.hits.map((hit) => hit.sessionId)).toContain('enabled-session')
  })

  it('drops the sink and closes the index when the user turns it back off', async () => {
    const { roots, databasePath } = await scanRoots()
    await writeClaudeTranscript(roots, 'toggled-session', 'the vacuum quota never settles')

    const service = makeService(databasePath, { enabled: true, historyDays: null })
    await service.ensureBackfill(roots)
    expect(getSessionSearchIndexSink()).not.toBeNull()

    const coverage = await service.configure({ enabled: false, historyDays: null }, roots)

    expect(getSessionSearchIndexSink()).toBeNull()
    expect(coverage.enabled).toBe(false)
    // The file survives a plain disable; only "Clear index" removes it.
    expect(existsSync(databasePath)).toBe(true)
  })

  it('deletes the database file when the user clears the index', async () => {
    const { roots, databasePath } = await scanRoots()
    await writeClaudeTranscript(roots, 'cleared-session', 'the vacuum quota never settles')

    const service = makeService(databasePath, { enabled: true, historyDays: null })
    await service.ensureBackfill(roots)
    await service.configure({ enabled: false, historyDays: null }, roots, { clearIndex: true })

    expect(existsSync(databasePath)).toBe(false)
    expect(existsSync(`${databasePath}-wal`)).toBe(false)
  })

  it('retries a backfill that failed instead of memoizing the failure', async () => {
    const { roots, databasePath } = await scanRoots()
    await writeClaudeTranscript(roots, 'retry-session', 'the vacuum quota never settles')

    const service = makeService(databasePath, { enabled: true, historyDays: null })
    failNextParseCacheLoad = true
    await service.ensureBackfill(roots)
    expect(service.coverage().sessionsIndexed).toBe(0)
    expect(service.coverage().backfill).toBe('idle')

    await service.ensureBackfill(roots)
    const result = await service.search({ query: 'vacuum', refresh: false }, roots)
    expect(result.hits.map((hit) => hit.sessionId)).toContain('retry-session')
  })

  it('re-enumerates when the history bound is widened after a finished backfill', async () => {
    const { roots, databasePath } = await scanRoots()
    await writeClaudeTranscript(roots, 'recent-session', 'the vacuum quota never settles', 1)
    await writeClaudeTranscript(roots, 'ancient-session', 'the vacuum quota never settles', 120)

    const service = makeService(databasePath, { enabled: true, historyDays: 30 })
    await service.ensureBackfill(roots)
    await service.configure({ enabled: true, historyDays: null }, roots)
    await service.ensureBackfill(roots)

    const result = await service.search({ query: 'vacuum', refresh: false }, roots)
    expect(result.hits.map((hit) => hit.sessionId)).toContain('ancient-session')
  })

  it('parks the backfill while a search is in flight', async () => {
    const { roots, databasePath } = await scanRoots()
    for (let i = 0; i < 24; i += 1) {
      await writeClaudeTranscript(roots, `bulk-session-${i}`, 'the vacuum quota never settles')
    }
    const service = makeService(databasePath, { enabled: true, historyDays: null })
    // Hold the backfill before its first file, start a search that stays in
    // flight past the release, and check the backfill did not advance meanwhile.
    let releaseBackfill!: () => void
    holdNextParseCacheLoad = new Promise<void>((resolve) => {
      releaseBackfill = resolve
    })
    const backfill = service.ensureBackfill(roots)
    let releaseSearch!: () => void
    holdSearchRefresh = new Promise<void>((resolve) => {
      releaseSearch = resolve
    })
    const search = service.search({ query: 'vacuum' }, roots)
    await new Promise((resolve) => setTimeout(resolve, 20))
    releaseBackfill()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(service.coverage().sessionsIndexed).toBeLessThanOrEqual(1)
    releaseSearch()
    await search
    await backfill
    expect(service.coverage().sessionsIndexed).toBe(24)
  })

  it('lets a disable interrupt a backfill parked behind a stalled search', async () => {
    const { roots, databasePath } = await scanRoots()
    for (let i = 0; i < 3; i += 1) {
      await writeClaudeTranscript(roots, `stall-session-${i}`, 'the vacuum quota never settles')
    }
    const service = makeService(databasePath, { enabled: true, historyDays: null })
    const backfill = service.ensureBackfill(roots)
    let releaseSearch!: () => void
    holdSearchRefresh = new Promise<void>((resolve) => {
      releaseSearch = resolve
    })
    const search = service.search({ query: 'vacuum' }, roots).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 100))

    await service.configure({ enabled: false, historyDays: null }, roots)
    await backfill
    expect(getSessionSearchIndexSink()).toBeNull()

    releaseSearch()
    await search
  })

  it('starts no replacement backfill while a disable is waiting on the old one', async () => {
    const { roots, databasePath } = await scanRoots()
    await writeClaudeTranscript(roots, 'race-session', 'the vacuum quota never settles')
    const service = makeService(databasePath, { enabled: true, historyDays: null })
    let releaseBackfill!: () => void
    holdNextParseCacheLoad = new Promise<void>((resolve) => {
      releaseBackfill = resolve
    })
    const backfill = service.ensureBackfill(roots)
    const disable = service.configure({ enabled: false, historyDays: null }, roots)
    // A search landing mid-stop sees an open store and a cleared backfill slot.
    const search = service.search({ query: 'vacuum', refresh: false }, roots).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    releaseBackfill()
    await Promise.all([backfill, disable, search])

    expect(parseCacheLoads).toBe(1)
    expect(getSessionSearchIndexSink()).toBeNull()
  })

  it('skips transcripts older than the history bound', async () => {
    const { roots, databasePath } = await scanRoots()
    await writeClaudeTranscript(roots, 'recent-session', 'the vacuum quota never settles', 1)
    await writeClaudeTranscript(roots, 'ancient-session', 'the vacuum quota never settles', 120)

    const service = makeService(databasePath, { enabled: true, historyDays: 30 })
    await service.ensureBackfill(roots)

    const result = await service.search({ query: 'vacuum', refresh: false }, roots)
    const ids = result.hits.map((hit) => hit.sessionId)
    expect(ids).toContain('recent-session')
    expect(ids).not.toContain('ancient-session')
  })
})
