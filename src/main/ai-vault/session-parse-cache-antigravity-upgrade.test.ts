import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  ensureSessionParseCacheLoaded,
  flushSessionParseCachePersist,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests,
  scheduleSessionParseCachePersist
} from './session-parse-cache-persistence'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests,
  snapshotSessionParseCacheForPersistence
} from './session-scanner-parse-cache'
import { createAntigravityWorkspaceResolver } from './session-scanner-antigravity-history'
import { writeAntigravityTranscript } from './session-scanner-test-fixtures'
import type { SessionFileCandidate } from './session-scanner-types'

let root: string | undefined
afterEach(async () => {
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

async function candidate(): Promise<SessionFileCandidate> {
  root = await mkdtemp(join(tmpdir(), 'orca-agy-cache-upgrade-'))
  const path = await writeAntigravityTranscript(
    join(root, 'brain'),
    'conversation',
    Array.from({ length: 8 }, (_, index) => ({
      source: 'USER',
      type: 'REQUEST',
      created_at: new Date(Date.parse('2026-07-15T11:39:10Z') + index * 60_000).toISOString(),
      content: index === 0 ? 'Original request' : `Follow-up ${index}`
    }))
  )
  const fileStat = await stat(path)
  return {
    agent: 'antigravity',
    codexHome: null,
    file: {
      path,
      mtimeMs: fileStat.mtimeMs,
      modifiedAt: fileStat.mtime.toISOString(),
      sizeBytes: fileStat.size
    }
  }
}

it('reparses an unchanged pre-fix cached Antigravity transcript after an update', async () => {
  const input = await candidate()
  await parseAgentSessionFileCached(input, 'linux')
  const entries = snapshotSessionParseCacheForPersistence().map(([path, entry]) => [
    path,
    {
      ...entry,
      session: entry.session && { ...entry.session, antigravityOpeningPrompt: undefined }
    }
  ])
  const cacheFile = join(root ?? '', 'cache.json')
  await writeFile(cacheFile, JSON.stringify({ schemaVersion: 3, appVersion: 'pre-fix', entries }))
  resetSessionParseCacheForTests()
  initSessionParseCachePersistence({ filePath: cacheFile, appVersion: 'fixed' })
  await ensureSessionParseCacheLoaded()
  const stats = createSessionParseStats()
  const session = await parseAgentSessionFileCached(input, 'linux', stats)
  expect(stats.fullParses).toBe(1)
  expect(stats.reused).toBe(0)
  if (!session) {
    throw new Error('Missing reparsed session')
  }
  expect(session.previewMessagesTruncated).toBe(true)
  const resolver = createAntigravityWorkspaceResolver(async (path) =>
    path === 'history.jsonl'
      ? JSON.stringify({
          display: 'Original request',
          timestamp: Date.parse('2026-07-15T11:39:10Z'),
          workspace: '/repo/original'
        })
      : null
  )
  expect((await resolver.enrich(session, 'history.jsonl')).cwd).toBe('/repo/original')
})

it('retains the opening identity in current caches without retaining full prompt text', async () => {
  const input = await candidate()
  const cacheFile = join(root ?? '', 'cache.json')
  initSessionParseCachePersistence({ filePath: cacheFile, appVersion: 'fixed' })
  const stats = createSessionParseStats()
  const original = await parseAgentSessionFileCached(input, 'linux', stats)
  scheduleSessionParseCachePersist(stats)
  await flushSessionParseCachePersist()
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
  initSessionParseCachePersistence({ filePath: cacheFile, appVersion: 'next-release' })
  await ensureSessionParseCacheLoaded()
  const reusedStats = createSessionParseStats()
  const reused = await parseAgentSessionFileCached(input, 'linux', reusedStats)
  expect(reused).toEqual(original)
  expect(reusedStats.reused).toBe(1)
  expect(reusedStats.fullParses).toBe(0)
  expect(reused?.antigravityOpeningPrompt?.timestamp).toBe('2026-07-15T11:39:10.000Z')
  expect(reused?.firstUserPrompt).toBeUndefined()
})
