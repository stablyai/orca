import { describe, expect, it, vi } from 'vitest'

import { getCachedRepos, setCachedRepos } from './repo-cache'

describe('repo cache', () => {
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
})
