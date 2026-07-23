import { describe, expect, it } from 'vitest'
import type { GitHubPRRefreshAlias, GitHubPRRefreshCandidate } from '../../shared/types'
import {
  boundedVisiblePRRefreshCandidates,
  PR_REFRESH_ALIAS_LIMIT,
  PR_REFRESH_RETRY_STATE_LIMIT,
  retainPRRefreshAlias,
  retainPRRefreshState
} from './pr-refresh-memory-bounds'
import { PR_REFRESH_VISIBLE_CANDIDATE_LIMIT } from '../../shared/pr-refresh-memory-limits'

function alias(index: number): GitHubPRRefreshAlias {
  return {
    cacheKey: `cache-${index}`,
    repoId: 'repo-1',
    repoPath: '/repo',
    branch: `feature-${index}`,
    worktreeId: `worktree-${index}`,
    connectionId: null,
    currentHeadOid: null,
    linkedPRNumber: 42,
    fallbackPRNumber: null,
    fallbackPRSource: null
  }
}

function candidate(index: number): GitHubPRRefreshCandidate {
  return {
    cacheKey: `cache-${index}`,
    repoId: 'repo-1',
    repoPath: '/repo',
    branch: `feature-${index}`,
    worktreeId: `worktree-${index}`,
    connectionId: null,
    currentHeadOid: null,
    linkedPRNumber: 42,
    fallbackPRNumber: null,
    fallbackPRSource: null,
    repoKind: 'git',
    cachedFetchedAt: null
  }
}

describe('PR refresh memory bounds', () => {
  it('retains ordinary aliases without changing their identity or order', () => {
    const aliases = new Map<string, GitHubPRRefreshAlias>()

    expect(retainPRRefreshAlias(aliases, alias(0), 'cache-0')).toBeNull()
    expect(retainPRRefreshAlias(aliases, alias(1), 'cache-0')).toBeNull()

    expect(Array.from(aliases.keys())).toEqual(['cache-0', 'cache-1'])
  })

  it('caps aliases while preserving the representative candidate', () => {
    const aliases = new Map<string, GitHubPRRefreshAlias>()
    for (let index = 0; index < PR_REFRESH_ALIAS_LIMIT; index += 1) {
      retainPRRefreshAlias(aliases, alias(index), 'cache-0')
    }

    const evicted = retainPRRefreshAlias(aliases, alias(PR_REFRESH_ALIAS_LIMIT), 'cache-0')

    expect(aliases).toHaveLength(PR_REFRESH_ALIAS_LIMIT)
    expect(aliases.has('cache-0')).toBe(true)
    expect(aliases.has(`cache-${PR_REFRESH_ALIAS_LIMIT}`)).toBe(true)
    expect(evicted?.cacheKey).toBe('cache-1')
  })

  it('caps retry state and refreshes existing keys without growing', () => {
    const states = new Map<number, number>()
    for (let index = 0; index < PR_REFRESH_RETRY_STATE_LIMIT; index += 1) {
      retainPRRefreshState(states, index, index, PR_REFRESH_RETRY_STATE_LIMIT)
    }

    expect(retainPRRefreshState(states, 1, 99, PR_REFRESH_RETRY_STATE_LIMIT)).toBeNull()
    expect(
      retainPRRefreshState(states, PR_REFRESH_RETRY_STATE_LIMIT, 1, PR_REFRESH_RETRY_STATE_LIMIT)
    ).toBe(0)
    expect(states).toHaveLength(PR_REFRESH_RETRY_STATE_LIMIT)
    expect(states.get(1)).toBe(99)
  })

  it('passes ordinary visible candidates through and truncates adversarial batches', () => {
    const ordinary = [candidate(0), candidate(1)]
    expect(boundedVisiblePRRefreshCandidates(ordinary)).toBe(ordinary)

    const oversized = Array.from({ length: PR_REFRESH_VISIBLE_CANDIDATE_LIMIT + 1 }, (_, index) =>
      candidate(index)
    )
    expect(boundedVisiblePRRefreshCandidates(oversized)).toHaveLength(
      PR_REFRESH_VISIBLE_CANDIDATE_LIMIT
    )
  })
})
