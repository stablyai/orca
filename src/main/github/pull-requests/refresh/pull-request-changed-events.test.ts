import { describe, expect, it } from 'vitest'
import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PRInfo } from '../../../../shared/github/pull-requests/pull-request-types'
import { pullRequestChangeObserver, type PullRequestChange } from './pull-request-changed-events'

const candidate: GitHubPRRefreshCandidate = {
  cacheKey: '/repo::feature',
  repoKind: 'git',
  repoId: 'repo-1',
  repoPath: '/repo',
  branch: 'feature',
  worktreeId: 'repo-1::/repo'
}

const pr: PRInfo = {
  number: 42,
  title: 'Add feature',
  state: 'open',
  url: 'https://github.com/acme/app/pull/42',
  checksStatus: 'pending',
  checksSummary: { state: 'pending', total: 1, passed: 0, failed: 0, pending: 1, neutral: 0 },
  updatedAt: '2026-11-09T10:00:00Z',
  mergeable: 'MERGEABLE',
  headSha: 'abc123'
}

describe('pullRequestChangeObserver', () => {
  it('publishes a found PR only when it differs from the last one published', () => {
    const published: PullRequestChange[] = []
    const observe = pullRequestChangeObserver((change) => published.push(change))

    observe(candidate, { kind: 'found', pr, fetchedAt: 1 }, [])
    // Same PR read again, with a field outside the change set moved.
    observe(candidate, { kind: 'found', pr: { ...pr, title: 'Renamed' }, fetchedAt: 2 }, [])
    observe(
      candidate,
      {
        kind: 'upstream-error',
        errorType: 'network',
        message: 'offline',
        fetchedAt: 3
      },
      []
    )
    // A read that couldn't load the checks reports neutral with no summary.
    const { checksSummary: _unloaded, ...withoutChecks } = pr
    observe(
      candidate,
      { kind: 'found', pr: { ...withoutChecks, checksStatus: 'neutral' }, fetchedAt: 4 },
      []
    )
    observe(
      candidate,
      {
        kind: 'found',
        pr: {
          ...pr,
          checksStatus: 'success',
          checksSummary: {
            state: 'success',
            total: 1,
            passed: 1,
            failed: 0,
            pending: 0,
            neutral: 0
          }
        },
        fetchedAt: 5
      },
      []
    )

    expect(published).toEqual([
      { worktreeId: 'repo-1::/repo', repoId: 'repo-1', branch: 'feature' },
      { worktreeId: 'repo-1::/repo', repoId: 'repo-1', branch: 'feature' }
    ])
  })

  // Checkouts linked to the same PR share one coordinator read.
  it('publishes for every checkout one read stood for', () => {
    const published: PullRequestChange[] = []
    const observe = pullRequestChangeObserver((change) => published.push(change))
    const sibling = {
      cacheKey: '/repo-b::other',
      repoPath: '/repo-b',
      branch: 'other',
      worktreeId: 'repo-1::/repo-b'
    }

    observe(candidate, { kind: 'found', pr, fetchedAt: 1 }, [candidate, sibling])

    expect(published).toEqual([
      { worktreeId: 'repo-1::/repo', repoId: 'repo-1', branch: 'feature' },
      { worktreeId: 'repo-1::/repo-b', repoId: 'repo-1', branch: 'other' }
    ])
  })
})
