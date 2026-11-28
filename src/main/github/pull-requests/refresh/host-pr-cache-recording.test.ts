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

  it('records a branch with no PR so a stale merged answer stops counting', () => {
    const store = memoryStore()
    recordHostPROutcome(store, repo, 'feature', { kind: 'found', pr: pr('merged'), fetchedAt: 1 })
    recordHostPROutcome(store, repo, 'feature', { kind: 'no-pr', fetchedAt: 2 })
    expect(readWorkspaceReviewPR(worktree, repo, store.getGitHubCache().pr)).toBeNull()
  })
})
