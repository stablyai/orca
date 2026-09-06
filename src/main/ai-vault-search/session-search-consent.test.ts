import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getSessionSearchIndexSink } from '../ai-vault/session-search-capture'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { isolatedScanRoots, jsonLines } from '../ai-vault/session-scanner-test-fixtures'
import { SessionSearchService, type SessionSearchScanRoots } from './session-search-service'

let tempRoots: string[] = []
let services: SessionSearchService[] = []

beforeEach(() => {
  resetSessionParseCacheForTests()
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
