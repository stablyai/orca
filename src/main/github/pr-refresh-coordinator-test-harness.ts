import type { GitHubPRRefreshCandidate } from '../../shared/github/pull-request-refresh-types'
import type { PRInfo } from '../../shared/github/pull-request-types'

export function makeCandidate(
  overrides: Partial<GitHubPRRefreshCandidate> = {}
): GitHubPRRefreshCandidate {
  return {
    cacheKey: '/repo::feature/test',
    repoPath: '/repo',
    branch: 'feature/test',
    repoKind: 'git',
    repoId: 'repo-1',
    worktreeId: 'wt-1',
    cachedFetchedAt: null,
    ...overrides
  }
}

export function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 12,
    title: 'Test PR',
    state: 'open',
    url: 'https://github.com/acme/repo/pull/12',
    checksStatus: 'pending',
    updatedAt: '2026-05-12T00:00:00Z',
    mergeable: 'MERGEABLE',
    headSha: 'head-sha',
    ...overrides
  }
}
