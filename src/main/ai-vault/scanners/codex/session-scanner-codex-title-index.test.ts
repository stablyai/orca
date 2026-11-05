import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  _getCodexSessionIndexTitleCacheSizeForTest,
  _readCachedCodexSessionIndexTitlesForTest,
  _storeCodexSessionIndexTitleCacheEntryForTest,
  resetCodexSessionIndexTitleCacheForTests
} from './session-scanner-codex-title-index'

let tempRoots: string[] = []

afterEach(async () => {
  resetCodexSessionIndexTitleCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('codex session index title cache', () => {
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
})
