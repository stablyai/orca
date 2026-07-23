import { describe, expect, it } from 'vitest'
import type { GitHubPRFileContents } from '../../../src/shared/types'
import {
  MOBILE_PR_FILE_CONTENT_CACHE_MAX_BYTES,
  MOBILE_PR_FILE_CONTENT_CACHE_MAX_ENTRIES,
  MobilePrFileContentCache,
  createMobilePrFileContentKey,
  createMobilePrFileContentScope,
  getMobilePrFileContentByteCount,
  getMobilePrFileContentsForScope
} from './mobile-pr-file-content-cache'
import {
  createMobileItemPrFileContentScope,
  createMobileProjectPrFileContentScope
} from './use-mobile-pr-file-content-cache'

function contents(original: string, modified = ''): GitHubPRFileContents {
  return {
    original,
    modified,
    originalIsBinary: false,
    modifiedIsBinary: false
  }
}

const scopeA = createMobilePrFileContentScope({
  source: 'item',
  repoId: 'repo-1',
  prNumber: 10,
  headSha: 'head-a',
  baseSha: 'base-a'
})
const scopeB = createMobilePrFileContentScope({
  source: 'item',
  repoId: 'repo-1',
  prNumber: 11,
  headSha: 'head-b',
  baseSha: 'base-a'
})

describe('MobilePrFileContentCache', () => {
  it('derives route scopes only from complete GitHub PR revisions', () => {
    expect(
      createMobileItemPrFileContentScope(
        { provider: 'github', source: { type: 'pr', repoId: 'repo-1', number: 10 } },
        { provider: 'github', headSha: 'head-a', baseSha: 'base-a' }
      )
    ).toBe(scopeA)
    expect(
      createMobileProjectPrFileContentScope(
        { itemType: 'PULL_REQUEST', content: { number: 10 } },
        { id: 'repo-1' },
        { provider: 'github', headSha: 'head-a' }
      )
    ).toBeNull()
    expect(
      createMobileProjectPrFileContentScope(
        { itemType: 'PULL_REQUEST', content: { number: 10 } },
        { id: 'repo-1' },
        { provider: 'github', headSha: 'head-a', baseSha: 'base-a' },
        { host: 'github.example', owner: 'orca', repo: 'app' }
      )
    ).toBe(
      createMobilePrFileContentScope({
        source: 'project',
        repoId: 'repo-1',
        prNumber: 10,
        headSha: 'head-a',
        baseSha: 'base-a',
        repository: { host: 'github.example', owner: 'orca', repo: 'app' }
      })
    )
  })

  it('uses the desktop diff budget as a hard byte cap with a smaller mobile entry cap', () => {
    expect(MOBILE_PR_FILE_CONTENT_CACHE_MAX_ENTRIES).toBeLessThan(64)
    expect(MOBILE_PR_FILE_CONTENT_CACHE_MAX_BYTES).toBe(24_000_000)
  })

  it('evicts least-recently-used files at the entry limit', () => {
    const cache = new MobilePrFileContentCache(2, 100)
    const a = createMobilePrFileContentKey({ path: 'a.ts' })
    const b = createMobilePrFileContentKey({ path: 'b.ts' })
    const c = createMobilePrFileContentKey({ path: 'c.ts' })
    cache.commitRequest(cache.beginRequest(scopeA, a), contents('a'))
    cache.commitRequest(cache.beginRequest(scopeA, b), contents('b'))
    expect(cache.select(scopeA, a).contents).toEqual(contents('a'))

    cache.commitRequest(cache.beginRequest(scopeA, c), contents('c'))

    expect(cache.evidence()).toMatchObject({ entryCount: 2, keysOldestFirst: [a, c] })
    expect(cache.select(scopeA, b).contents).toBeUndefined()
  })

  it('evicts older payloads to stay within the byte budget', () => {
    const cache = new MobilePrFileContentCache(10, 8)
    const a = createMobilePrFileContentKey({ path: 'a.ts' })
    const b = createMobilePrFileContentKey({ path: 'b.ts' })
    cache.commitRequest(cache.beginRequest(scopeA, a), contents('12345'))
    cache.commitRequest(cache.beginRequest(scopeA, b), contents('67890'))

    expect(cache.evidence()).toMatchObject({
      entryCount: 1,
      retainedBytes: 5,
      keysOldestFirst: [b]
    })
  })

  it('measures retained UTF-8 bytes rather than JavaScript code units', () => {
    expect(getMobilePrFileContentByteCount(contents('a😀', 'é'))).toBe(7)
  })

  it('counts the retained side when the other side is an oversized sentinel', () => {
    expect(
      getMobilePrFileContentByteCount({
        ...contents('', 'retained'),
        originalTooLarge: true
      })
    ).toBe(8)
  })

  it('rejects a response from a prior PR context after scope replacement', () => {
    const cache = new MobilePrFileContentCache(2, 100)
    const key = createMobilePrFileContentKey({ path: 'file.ts' })
    const oldRequest = cache.beginRequest(scopeA, key)
    cache.activateScope(scopeB)

    expect(cache.commitRequest(oldRequest, contents('stale'))).toBe('stale')
    expect(cache.evidence()).toMatchObject({ scope: scopeB, entryCount: 0, retainedBytes: 0 })
  })

  it('rejects an older request after the active file selection changes', () => {
    const cache = new MobilePrFileContentCache(2, 100)
    const a = createMobilePrFileContentKey({ path: 'a.ts' })
    const b = createMobilePrFileContentKey({ path: 'b.ts' })
    const oldRequest = cache.beginRequest(scopeA, a)
    cache.select(scopeA, b)
    const currentRequest = cache.beginRequest(scopeA, b)

    expect(cache.commitRequest(oldRequest, contents('stale'))).toBe('stale')
    expect(cache.commitRequest(currentRequest, contents('current'))).toBe('stored')
  })

  it('publishes only the active scope and refuses a single over-budget payload', () => {
    const cache = new MobilePrFileContentCache(2, 4)
    const key = createMobilePrFileContentKey({ path: 'file.ts' })
    expect(cache.commitRequest(cache.beginRequest(scopeA, key), contents('12345'))).toBe(
      'too-large'
    )
    expect(getMobilePrFileContentsForScope(cache.snapshot(), scopeA)).toEqual({})
    expect(getMobilePrFileContentsForScope(cache.snapshot(), scopeB)).toEqual({})
  })
})
