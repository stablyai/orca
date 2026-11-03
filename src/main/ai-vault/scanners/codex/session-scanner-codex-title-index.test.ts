import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  _getCodexSessionIndexTitleCacheSizeForTest,
  _hasCodexSessionIndexTitleCacheEntryForTest,
  _readCachedCodexSessionIndexTitlesForTest,
  _storeCodexSessionIndexTitleCacheEntryForTest,
  readCodexSessionIndexTitle,
  resetCodexSessionIndexTitleCacheForTests
} from './session-scanner-codex-title-index'

const CACHE_LIMIT = 64

let tempRoots: string[] = []

afterEach(async () => {
  resetCodexSessionIndexTitleCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function createCodexHome(index: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-title-index-'))
  tempRoots.push(root)
  const codexHome = join(root, `codex-home-${index}`)
  await mkdir(join(codexHome, 'sessions'), { recursive: true })
  await writeFile(
    join(codexHome, 'session_index.jsonl'),
    `${JSON.stringify({ id: `session-${index}`, thread_name: `Title ${index}` })}\n`
  )
  return codexHome
}

async function readTitle(codexHome: string, index: number): Promise<string | null> {
  return readCodexSessionIndexTitle(
    join(codexHome, 'sessions', `session-${index}.jsonl`),
    codexHome,
    `session-${index}`
  )
}

describe('codex session index title cache', () => {
  it('caps cached title indexes by Codex home', async () => {
    const homes: string[] = []

    for (let index = 0; index < CACHE_LIMIT + 1; index++) {
      const codexHome = await createCodexHome(index)
      homes.push(codexHome)
      expect(await readTitle(codexHome, index)).toBe(`Title ${index}`)
    }

    expect(_getCodexSessionIndexTitleCacheSizeForTest()).toBe(CACHE_LIMIT)
    expect(_hasCodexSessionIndexTitleCacheEntryForTest(homes[0])).toBe(false)
    expect(_hasCodexSessionIndexTitleCacheEntryForTest(homes[CACHE_LIMIT])).toBe(true)
  })

  it('refreshes cache recency when an existing Codex home is reused', async () => {
    const homes: string[] = []
    for (let index = 0; index < CACHE_LIMIT; index++) {
      const codexHome = await createCodexHome(index)
      homes.push(codexHome)
      await readTitle(codexHome, index)
    }

    await readTitle(homes[0], 0)
    const extraHome = await createCodexHome(CACHE_LIMIT)
    await readTitle(extraHome, CACHE_LIMIT)

    expect(_getCodexSessionIndexTitleCacheSizeForTest()).toBe(CACHE_LIMIT)
    expect(_hasCodexSessionIndexTitleCacheEntryForTest(homes[0])).toBe(true)
    expect(_hasCodexSessionIndexTitleCacheEntryForTest(homes[1])).toBe(false)
  })

  it('does not resurrect a pending cache hit after that home is evicted', async () => {
    let resolveSlowTitles: (titles: Map<string, string>) => void = () => {}
    const slowTitles = new Promise<Map<string, string>>((resolve) => {
      resolveSlowTitles = resolve
    })
    _storeCodexSessionIndexTitleCacheEntryForTest('slow-home', 'stable', slowTitles)
    const pendingHit = _readCachedCodexSessionIndexTitlesForTest('slow-home', 'stable')

    for (let index = 0; index < CACHE_LIMIT; index += 1) {
      _storeCodexSessionIndexTitleCacheEntryForTest(
        `replacement-home-${index}`,
        `signature-${index}`,
        Promise.resolve(new Map([[`session-${index}`, `Title ${index}`]]))
      )
    }
    expect(_getCodexSessionIndexTitleCacheSizeForTest()).toBe(CACHE_LIMIT)
    expect(_hasCodexSessionIndexTitleCacheEntryForTest('slow-home')).toBe(false)

    const titles = new Map([['slow-session', 'Slow title']])
    resolveSlowTitles(titles)

    await expect(pendingHit).resolves.toBe(titles)
    expect(_getCodexSessionIndexTitleCacheSizeForTest()).toBe(CACHE_LIMIT)
    expect(_hasCodexSessionIndexTitleCacheEntryForTest('slow-home')).toBe(false)
  })

  it('does not replace a newer same-home entry when an older cache hit resolves', async () => {
    let resolveOldTitles: (titles: Map<string, string>) => void = () => {}
    const oldTitles = new Promise<Map<string, string>>((resolve) => {
      resolveOldTitles = resolve
    })
    _storeCodexSessionIndexTitleCacheEntryForTest('same-home', 'old', oldTitles)
    const pendingOldHit = _readCachedCodexSessionIndexTitlesForTest('same-home', 'old')

    const newTitles = new Map([['new-session', 'New title']])
    _storeCodexSessionIndexTitleCacheEntryForTest('same-home', 'new', Promise.resolve(newTitles))
    const resolvedOldTitles = new Map([['old-session', 'Old title']])
    resolveOldTitles(resolvedOldTitles)

    await expect(pendingOldHit).resolves.toBe(resolvedOldTitles)
    await expect(_readCachedCodexSessionIndexTitlesForTest('same-home', 'new')).resolves.toBe(
      newTitles
    )
    expect(_getCodexSessionIndexTitleCacheSizeForTest()).toBe(1)
  })

  it('preserves a newer same-home entry when an older cache hit rejects', async () => {
    let rejectOldTitles: (error: Error) => void = () => {}
    const oldTitles = new Promise<Map<string, string>>((_resolve, reject) => {
      rejectOldTitles = reject
    })
    _storeCodexSessionIndexTitleCacheEntryForTest('same-home', 'old', oldTitles)
    const pendingOldHit = _readCachedCodexSessionIndexTitlesForTest('same-home', 'old')

    const newTitles = new Map([['new-session', 'New title']])
    _storeCodexSessionIndexTitleCacheEntryForTest('same-home', 'new', Promise.resolve(newTitles))
    rejectOldTitles(new Error('old read failed'))

    await expect(pendingOldHit).rejects.toThrow('old read failed')
    await expect(_readCachedCodexSessionIndexTitlesForTest('same-home', 'new')).resolves.toBe(
      newTitles
    )
    expect(_getCodexSessionIndexTitleCacheSizeForTest()).toBe(1)
  })
})
