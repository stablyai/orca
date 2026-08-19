import { describe, expect, it, vi } from 'vitest'

import { getCachedRepos, setCachedRepos } from './repo-cache'

describe('repo cache', () => {
  it('returns recent host-scoped repos', () => {
    const repos = [{ id: 'repo-1', displayName: 'Repo 1' }]

    setCachedRepos('host-1', repos)

    expect(getCachedRepos('host-1')).toEqual(repos)
    expect(getCachedRepos('host-2')).toBeNull()
  })

  it('keeps validated stale entries available as an explicit fallback', () => {
    vi.useFakeTimers()
    try {
      setCachedRepos('host-stale', [{ id: 'repo-stale', displayName: 'Stale' }])
      vi.advanceTimersByTime(60_001)
      setCachedRepos('host-stale', [
        { id: 'repo-poisoned', displayName: 'Poisoned', badgeColor: 'not-a-color' }
      ])

      expect(getCachedRepos('host-stale')).toBeNull()
      expect(getCachedRepos('host-stale', { allowStale: true })).toEqual([
        { id: 'repo-stale', displayName: 'Stale' }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not replace safe metadata with malformed render decorations', () => {
    const safe = [{ id: 'repo-safe', displayName: 'Safe', badgeColor: '#abcdef' }]
    setCachedRepos('host-poisoned', safe)

    setCachedRepos('host-poisoned', [
      {
        id: 'repo-poisoned',
        displayName: 'Poisoned',
        badgeColor: 'url(javascript:alert(1))'
      }
    ])
    setCachedRepos('host-poisoned', [
      {
        id: 'repo-poisoned-icon',
        displayName: 'Poisoned icon',
        repoIcon: { type: 'image', source: 'favicon', src: 'http://example.test/icon.png' }
      }
    ])

    expect(getCachedRepos('host-poisoned')).toEqual(safe)
  })
})
