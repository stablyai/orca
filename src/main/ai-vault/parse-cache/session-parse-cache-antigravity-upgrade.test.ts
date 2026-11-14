import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  flushSessionParseCachePersist,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests
} from './session-parse-cache-persistence'
import { createSessionParseStats, parseAgentSessionFileCached } from './session-scanner-parse-cache'
import { resetSessionParseCacheForTests } from './session-parse-cache-store'

import { writeAntigravityTranscript } from '../scanner-fixtures/session-scanner-test-fixtures'
import type { SessionFileCandidate } from '../session-scanner-types'

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

it('retains the opening identity in current caches without retaining full prompt text', async () => {
  const input = await candidate()
  const cacheFile = join(root ?? '', 'cache.json')
  initSessionParseCachePersistence({ filePath: cacheFile, appVersion: 'fixed' })
  const stats = createSessionParseStats()
  const original = await parseAgentSessionFileCached(input, 'linux', stats)
  await flushSessionParseCachePersist()
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
  initSessionParseCachePersistence({ filePath: cacheFile, appVersion: 'next-release' })
  const reusedStats = createSessionParseStats()
  const reused = await parseAgentSessionFileCached(input, 'linux', reusedStats)
  expect(reused).toEqual(original)
  expect(reusedStats.reused).toBe(1)
  expect(reusedStats.fullParses).toBe(0)
  expect(reused?.antigravityOpeningPrompt?.timestamp).toBe('2026-07-15T11:39:10.000Z')
  expect(reused?.firstUserPrompt).toBeUndefined()
})
