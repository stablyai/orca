import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  ensureSessionParseCacheLoaded,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests
} from './session-parse-cache-persistence'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests,
  snapshotSessionParseCacheForPersistence
} from './session-scanner-parse-cache'
import type { SessionFileCandidate } from './session-scanner-types'

let root: string | undefined

afterEach(async () => {
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('reparses unchanged ATIF transcripts cached before Devin source fields were supported', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-devin-upgrade-'))
  const path = join(root, 'devin-session.json')
  await writeFile(
    path,
    JSON.stringify({
      session_id: 'devin-session',
      steps: [{ source: 'user', message: 'Find the missing sessions' }]
    })
  )
  const fileStat = await stat(path)
  const candidate: SessionFileCandidate = {
    agent: 'devin',
    codexHome: null,
    file: {
      path,
      mtimeMs: fileStat.mtimeMs,
      modifiedAt: fileStat.mtime.toISOString(),
      sizeBytes: fileStat.size,
      sidecar: 'none'
    }
  }
  await parseAgentSessionFileCached(candidate, process.platform)
  const entries = snapshotSessionParseCacheForPersistence().map(([filePath, entry]) => [
    filePath,
    {
      ...entry,
      session: entry.session && {
        ...entry.session,
        title: 'Devin session devin-session',
        messageCount: 0,
        previewMessages: [],
        firstUserPrompt: null,
        lastUserPrompt: null
      }
    }
  ])
  const cacheFile = join(root, 'cache.json')
  await writeFile(cacheFile, JSON.stringify({ schemaVersion: 2, appVersion: 'old', entries }))
  resetSessionParseCacheForTests()
  initSessionParseCachePersistence({ filePath: cacheFile, appVersion: 'new' })
  await ensureSessionParseCacheLoaded()

  const stats = createSessionParseStats()
  const session = await parseAgentSessionFileCached(candidate, process.platform, stats)
  expect(stats.fullParses).toBe(1)
  expect(stats.reused).toBe(0)
  expect(session?.messageCount).toBe(1)
  expect(session?.title).toBe('Find the missing sessions')
})
