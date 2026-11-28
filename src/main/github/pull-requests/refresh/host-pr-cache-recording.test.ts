import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import type { PRInfo } from '../../../../shared/github/pull-requests/pull-request-types'
import { readWorkspaceReviewPR } from '../../../../shared/sidebar-list/feed-facts/workspace-review-facts'
import { recordHostPROutcome } from './host-pr-cache-recording'

const repo = { id: 'repo-1', path: '/home/me/repo', connectionId: null, executionHostId: undefined }
const worktree = { branch: 'refs/heads/feature', linkedPR: 42, suppressedGitHubPR: undefined }

function pr(state: PRInfo['state']): PRInfo {
  return {
    number: 42,
    title: 'Feature',
    state,
    url: 'https://github.com/o/r/pull/42',
    checksStatus: 'success',
    updatedAt: '2026-11-01T00:00:00Z',
    mergeable: 'UNKNOWN'
  }
}

function memoryStore() {
  let cache: PersistedState['githubCache'] = { pr: {}, issue: {} }
  return {
    getGitHubCache: () => cache,
    setGitHubCache: vi.fn((next: PersistedState['githubCache']) => {
      cache = next
    })
  }
}

describe('recordHostPROutcome', () => {
  it('fills the cache key that worktree.ps and the cleanup scan read', () => {
    const store = memoryStore()
    recordHostPROutcome(store, repo, 'feature', { kind: 'found', pr: pr('merged'), fetchedAt: 1 })
    expect(readWorkspaceReviewPR(worktree, repo, store.getGitHubCache().pr)?.state).toBe('merged')
  })

  it('keeps the last answer on an error and skips unchanged or older answers', () => {
    const store = memoryStore()
    recordHostPROutcome(store, repo, 'feature', { kind: 'found', pr: pr('open'), fetchedAt: 5 })
    recordHostPROutcome(store, repo, 'feature', {
      kind: 'upstream-error',
      errorType: 'network',
      message: 'offline',
      fetchedAt: 6
    })
    recordHostPROutcome(store, repo, 'feature', { kind: 'found', pr: pr('open'), fetchedAt: 7 })
    recordHostPROutcome(store, repo, 'feature', { kind: 'found', pr: pr('merged'), fetchedAt: 4 })
    expect(store.setGitHubCache).toHaveBeenCalledTimes(1)
    expect(readWorkspaceReviewPR(worktree, repo, store.getGitHubCache().pr)?.state).toBe('open')
  })

  it('keeps a merged PR on an unlinked miss while its head is still checked out', () => {
    const store = memoryStore()
    const merged = { ...pr('merged'), headSha: 'abc' }
    recordHostPROutcome(store, repo, 'feature', { kind: 'found', pr: merged, fetchedAt: 1 })
    recordHostPROutcome(
      store,
      repo,
      'feature',
      { kind: 'no-pr', fetchedAt: 2 },
      {
        currentHeadOid: 'abc'
      }
    )
    expect(readWorkspaceReviewPR(worktree, repo, store.getGitHubCache().pr)?.state).toBe('merged')
    // A linked lookup that finds nothing is authoritative and clears it.
    recordHostPROutcome(
      store,
      repo,
      'feature',
      { kind: 'no-pr', fetchedAt: 3 },
      {
        linkedPRNumber: 42,
        currentHeadOid: 'abc'
      }
    )
    expect(readWorkspaceReviewPR(worktree, repo, store.getGitHubCache().pr)).toBeNull()
  })

  it('clears a merged PR on a miss once the worktree moved to another head', () => {
    const store = memoryStore()
    const merged = { ...pr('merged'), headSha: 'abc' }
    recordHostPROutcome(store, repo, 'feature', { kind: 'found', pr: merged, fetchedAt: 1 })
    recordHostPROutcome(
      store,
      repo,
      'feature',
      { kind: 'no-pr', fetchedAt: 2 },
      {
        currentHeadOid: 'def'
      }
    )
    expect(readWorkspaceReviewPR(worktree, repo, store.getGitHubCache().pr)).toBeNull()
  })

  it('keeps a merged PR on an unlinked miss that names no head', () => {
    const store = memoryStore()
    const merged = { ...pr('merged'), headSha: 'abc' }
    recordHostPROutcome(store, repo, 'feature', { kind: 'found', pr: merged, fetchedAt: 1 })
    recordHostPROutcome(store, repo, 'feature', { kind: 'no-pr', fetchedAt: 2 })
    expect(readWorkspaceReviewPR(worktree, repo, store.getGitHubCache().pr)?.state).toBe('merged')
  })

  it('treats a reordered but equal PR as unchanged', () => {
    const store = memoryStore()
    const { number, ...rest } = pr('open')
    recordHostPROutcome(store, repo, 'feature', { kind: 'found', pr: pr('open'), fetchedAt: 1 })
    recordHostPROutcome(store, repo, 'feature', {
      kind: 'found',
      pr: { ...rest, number },
      fetchedAt: 2
    })
    expect(store.setGitHubCache).toHaveBeenCalledTimes(1)
  })

  it('bounds the cache by evicting the oldest entries', () => {
    const store = memoryStore()
    for (let i = 0; i < 502; i += 1) {
      recordHostPROutcome(store, repo, `b${i}`, { kind: 'found', pr: pr('open'), fetchedAt: i })
    }
    const keys = Object.keys(store.getGitHubCache().pr)
    expect(keys).toHaveLength(500)
    expect(keys).not.toContain('repo-1::b0')
  })
})
