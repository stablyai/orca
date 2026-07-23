import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getCachedRepos,
  MOBILE_REPO_CACHE_MAX_ITEMS_PER_HOST,
  resetRepoCacheForTests,
  setCachedRepos
} from './repo-cache'

describe('repo cache', () => {
  beforeEach(() => {
    resetRepoCacheForTests()
  })

  it('returns recent host-scoped repos', () => {
    const repos = [{ id: 'repo-1' }]

    setCachedRepos('host-1', repos)

    expect(getCachedRepos('host-1')).toBe(repos)
    expect(getCachedRepos('host-2')).toBeNull()
  })

  it('expires stale entries', () => {
    vi.useFakeTimers()
    try {
      setCachedRepos('host-stale', [{ id: 'repo-stale' }])
      vi.advanceTimersByTime(60_001)

      expect(getCachedRepos('host-stale')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains the exact per-host item cap and rejects one over', () => {
    const exact = Array.from({ length: MOBILE_REPO_CACHE_MAX_ITEMS_PER_HOST }, () => null)
    setCachedRepos('host', exact)
    expect(getCachedRepos('host')).toBe(exact)

    setCachedRepos('host', [...exact, null])
    expect(getCachedRepos('host')).toBeNull()
  })
})
