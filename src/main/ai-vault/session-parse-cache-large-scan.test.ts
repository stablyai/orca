import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import {
  flushSessionParseCachePersist,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests
} from './session-parse-cache-persistence'
import {
  getSessionParseCacheEntry,
  MAX_RESUME_ENTRIES,
  MAX_UNLISTED_ENTRIES,
  noteSessionParseCacheListed,
  resetSessionParseCacheForTests,
  storeSessionParseCacheEntry
} from './session-parse-cache-store'
import { createSessionParseStats, parseListedSessionFile } from './session-scanner-parse-cache'
import type { SessionFileCandidate } from './session-scanner-types'

const CANDIDATES = Math.max(MAX_RESUME_ENTRIES, MAX_UNLISTED_ENTRIES) + 178
let root: string | undefined

afterEach(async () => {
  resetSessionParseCachePersistenceForTests()
  resetSessionParseCacheForTests()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = undefined
})

it('count-bounds rows only other readers made, never rows History listed', () => {
  const row = { mtimeMs: 1, sizeBytes: 1, platform: 'linux', session: null, resume: null } as const
  noteSessionParseCacheListed('listed')
  storeSessionParseCacheEntry('listed', row)
  for (let index = 0; index <= MAX_UNLISTED_ENTRIES; index++) {
    storeSessionParseCacheEntry(`search-${index}`, row)
  }
  expect(getSessionParseCacheEntry('listed')).toBeDefined()
  expect(getSessionParseCacheEntry('search-0')).toBeUndefined()
  expect(getSessionParseCacheEntry(`search-${MAX_UNLISTED_ENTRIES}`)).toBeDefined()
})

it('does not reparse an unchanged corpus past the resume bound, across scans or restart', async () => {
  resetSessionParseCacheForTests()
  root = await mkdtemp(join(tmpdir(), 'orca-history-no-reparse-'))
  const cacheFile = join(root, 'cache.json')
  initSessionParseCachePersistence({ filePath: cacheFile, appVersion: 'test' })
  const candidates: SessionFileCandidate[] = []
  for (let index = 0; index < CANDIDATES; index++) {
    const path = join(root, `session-${index}.jsonl`)
    await writeFile(path, '')
    const fileStat = await stat(path)
    candidates.push({
      agent: 'claude',
      file: {
        path,
        mtimeMs: fileStat.mtimeMs,
        modifiedAt: fileStat.mtime.toISOString(),
        sizeBytes: fileStat.size
      },
      codexHome: null
    })
  }
  const first = createSessionParseStats()
  const second = createSessionParseStats()
  const restarted = createSessionParseStats()
  const list = async (stats: ReturnType<typeof createSessionParseStats>) => {
    for (const candidate of candidates) {
      await parseListedSessionFile(candidate, process.platform, stats)
    }
  }
  await list(first)
  await list(second)
  await flushSessionParseCachePersist()
  const db = new SyncDatabase(join(root, 'session-parse-cache.sqlite'))
  expect(db.prepare('SELECT COUNT(*) AS count FROM rows').get()).toEqual({ count: CANDIDATES })
  db.close()
  resetSessionParseCachePersistenceForTests()
  resetSessionParseCacheForTests()
  initSessionParseCachePersistence({ filePath: cacheFile, appVersion: 'test' })
  expect(getSessionParseCacheEntry(candidates[0]!.file.path)).toBeDefined()
  await list(restarted)
  expect(first.fullParses).toBe(CANDIDATES)
  expect(second.fullParses).toBe(0)
  expect(restarted.fullParses).toBe(0)
}, 240_000)
