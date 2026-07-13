import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KimiSessionIndexCache,
  KIMI_WORK_DIR_CACHE_MAX_INDEX_PATHS,
  KIMI_WORK_DIR_CACHE_TTL_MS,
  type KimiSessionIndexIdentity
} from './session-scanner-kimi-index-cache'
import {
  clearKimiSessionIndexCache,
  hasKimiSessionIndexCacheEntryForTests,
  readKimiWorkDirBySessionId
} from './session-scanner-kimi-paths'

const IDENTITY: KimiSessionIndexIdentity = {
  changeTimeMs: 1,
  mtimeMs: 1,
  sizeBytes: 1
}
let tempDirs: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  clearKimiSessionIndexCache()
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('KimiSessionIndexCache', () => {
  it('bounds prolonged path churn and retains a reused index', async () => {
    const cache = new KimiSessionIndexCache()

    for (let index = 0; index < KIMI_WORK_DIR_CACHE_MAX_INDEX_PATHS; index += 1) {
      const path = `home-${index}/session_index.jsonl`
      await cache.get(path, IDENTITY, cache.beginRead(), async () => new Map([[path, path]]))
    }
    const reusedPath = 'home-0/session_index.jsonl'
    await cache.get(reusedPath, IDENTITY, cache.beginRead(), async () => new Map())

    const firstOverflowPath = `home-${KIMI_WORK_DIR_CACHE_MAX_INDEX_PATHS}/session_index.jsonl`
    await cache.get(
      firstOverflowPath,
      IDENTITY,
      cache.beginRead(),
      async () => new Map([[firstOverflowPath, firstOverflowPath]])
    )
    expect(cache.has(reusedPath)).toBe(true)
    expect(cache.has('home-1/session_index.jsonl')).toBe(false)

    for (let index = KIMI_WORK_DIR_CACHE_MAX_INDEX_PATHS + 1; index < 640; index += 1) {
      const path = `home-${index}/session_index.jsonl`
      await cache.get(path, IDENTITY, cache.beginRead(), async () => new Map([[path, path]]))
    }

    expect(cache.has(reusedPath)).toBe(false)
    expect(cache.size).toBe(KIMI_WORK_DIR_CACHE_MAX_INDEX_PATHS)
    expect(cache.has('home-576/session_index.jsonl')).toBe(true)
    expect(cache.has('home-575/session_index.jsonl')).toBe(false)
    cache.clear()
  })

  it('refreshes active entries and expires them after an idle TTL', async () => {
    vi.useFakeTimers()
    const cache = new KimiSessionIndexCache()
    const path = 'active/session_index.jsonl'
    const value = new Map([['session', '/repo']])

    await cache.get(path, IDENTITY, cache.beginRead(), async () => value)
    await vi.advanceTimersByTimeAsync(KIMI_WORK_DIR_CACHE_TTL_MS - 1)
    expect(await cache.get(path, IDENTITY, cache.beginRead(), async () => new Map())).toBe(value)

    await vi.advanceTimersByTimeAsync(KIMI_WORK_DIR_CACHE_TTL_MS - 1)
    expect(cache.has(path)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(cache.has(path)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('deduplicates concurrent reads of the same file identity', async () => {
    const cache = new KimiSessionIndexCache()
    const load = vi.fn(async () => new Map([['session', '/repo']]))
    const first = cache.get('index', IDENTITY, cache.beginRead(), load)
    const second = cache.get('index', IDENTITY, cache.beginRead(), load)

    expect(second).toBe(first)
    await expect(second).resolves.toEqual(new Map([['session', '/repo']]))
    expect(load).toHaveBeenCalledOnce()
    cache.clear()
  })

  it('does not let an older mutation race replace a newer identity', async () => {
    const cache = new KimiSessionIndexCache()
    const oldGeneration = cache.beginRead()
    const newGeneration = cache.beginRead()
    const newerIdentity = { ...IDENTITY, changeTimeMs: 2, mtimeMs: 2, sizeBytes: 2 }
    const newer = new Map([['session', '/new']])

    await cache.get('index', newerIdentity, newGeneration, async () => newer)
    await cache.get('index', IDENTITY, oldGeneration, async () => new Map([['session', '/old']]))
    const reload = vi.fn(async () => new Map())

    await expect(cache.get('index', newerIdentity, cache.beginRead(), reload)).resolves.toBe(newer)
    expect(reload).not.toHaveBeenCalled()
    cache.clear()
  })

  it('does not repopulate after an owner clears an in-flight read', async () => {
    const cache = new KimiSessionIndexCache()
    const staleGeneration = cache.beginRead()
    cache.clear()

    await cache.get('index', IDENTITY, staleGeneration, async () => new Map([['session', '/old']]))

    expect(cache.has('index')).toBe(false)
    const current = new Map([['session', '/current']])
    await expect(
      cache.get('index', IDENTITY, cache.beginRead(), async () => current)
    ).resolves.toBe(current)
    expect(cache.has('index')).toBe(true)
    cache.clear()
  })
})

describe('Kimi session index reader cache', () => {
  it('releases a retained map when its index file disappears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-kimi-index-delete-'))
    tempDirs.push(root)
    const indexPath = join(root, 'session_index.jsonl')
    await writeFile(indexPath, `${JSON.stringify({ sessionId: 'session', workDir: '/repo' })}\n`)

    await readKimiWorkDirBySessionId(indexPath)
    expect(hasKimiSessionIndexCacheEntryForTests(indexPath)).toBe(true)
    await rm(indexPath)

    await expect(readKimiWorkDirBySessionId(indexPath)).resolves.toEqual(new Map())
    expect(hasKimiSessionIndexCacheEntryForTests(indexPath)).toBe(false)
  })

  it('invalidates when size changes even if the mtime is restored', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-kimi-index-mutation-'))
    tempDirs.push(root)
    const indexPath = join(root, 'session_index.jsonl')
    await writeFile(indexPath, `${JSON.stringify({ sessionId: 'session-old', workDir: '/old' })}\n`)
    const originalStat = await stat(indexPath)

    await expect(readKimiWorkDirBySessionId(indexPath)).resolves.toEqual(
      new Map([['session-old', '/old']])
    )
    await writeFile(
      indexPath,
      `${JSON.stringify({ sessionId: 'session-old', workDir: '/old' })}\n${JSON.stringify({ sessionId: 'session-new', workDir: '/new' })}\n`
    )
    await utimes(indexPath, originalStat.atime, originalStat.mtime)

    await expect(readKimiWorkDirBySessionId(indexPath)).resolves.toEqual(
      new Map([
        ['session-old', '/old'],
        ['session-new', '/new']
      ])
    )
  })
})
