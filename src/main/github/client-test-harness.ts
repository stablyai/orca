import type { GitHubClientMocks } from './client-test-mocks'
import { _resetOwnerRepoCache } from './gh-utils'
import { _resetMergeQueueCacheForTests } from './client/detect/repository-merge-metadata-cache'
import { _resetPRStackSummaryCacheForTests } from './client/lookup/pr-stack-summary-cache'
import { __resetTrackedUpstreamBranchCacheForTests } from './client/lookup/tracked-upstream-cache'
import { __resetPRConflictSummaryCachesForTests } from './conflict-summary'
import { resetMergedPRCommitMembershipCacheForTest } from './merged-pr-commit-membership'
import { __resetRepoDefaultBranchCacheForTests } from '../source-control/repo-default-branch'
import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository'
import { _resetGitHubPRStackCacheForTests } from './github-pr-stack'

export function resetOriginRepositoryCache(): void {
  _resetOriginGitHubApiRepositoryCache()
}

export function resetPRForBranchMocks(mocks: GitHubClientMocks): void {
  resetOriginRepositoryCache()
  mocks.execFileAsyncMock.mockReset()
  mocks.ghExecFileAsyncMock.mockReset()
  mocks.getOwnerRepoMock.mockReset()
  mocks.getIssueOwnerRepoMock.mockReset()
  mocks.getOwnerRepoForRemoteMock.mockReset()
  // Route origin probes through the suite's repository fixture.
  mocks.getOwnerRepoForRemoteMock.mockImplementation(
    async (repoPath: string, remoteName: string, connectionId?: string | null, opts = {}) =>
      remoteName === 'origin' ? mocks.getOwnerRepoMock(repoPath, connectionId, opts) : null
  )
  mocks.resolvePRRepositoryCandidatesMock.mockReset()
  mocks.resolvePRRepositoryCandidatesMock.mockImplementation(async (repoPath, connectionId) => {
    const origin = await mocks.getOwnerRepoMock(repoPath, connectionId)
    return { candidates: origin ? [origin] : [], headRepo: origin }
  })
  mocks.getRemoteUrlForRepoMock.mockReset()
  mocks.gitExecFileAsyncMock.mockReset()
  mocks.getRateLimitMock.mockReset()
  mocks.getRateLimitMock.mockResolvedValue({ resources: {} })
  mocks.rateLimitGuardMock.mockReset()
  mocks.rateLimitGuardMock.mockReturnValue({ blocked: false })
  mocks.noteRateLimitSpendMock.mockReset()
  mocks.ghRepoExecOptionsMock.mockClear()
  mocks.githubRepoContextMock.mockClear()
  mocks.readLocalGitConfigSignatureMock.mockReset()
  mocks.readLocalGitConfigSignatureMock.mockResolvedValue(undefined)
  mocks.acquireMock.mockReset()
  mocks.releaseMock.mockReset()
  mocks.acquireMock.mockResolvedValue(undefined)
  _resetOwnerRepoCache()
  _resetMergeQueueCacheForTests()
  _resetPRStackSummaryCacheForTests()
  _resetGitHubPRStackCacheForTests()
  __resetTrackedUpstreamBranchCacheForTests()
  __resetPRConflictSummaryCachesForTests()
  resetMergedPRCommitMembershipCacheForTest()
  __resetRepoDefaultBranchCacheForTests()
}

export function resetGraphQLRateLimitGuardMocks(mocks: GitHubClientMocks): void {
  resetOriginRepositoryCache()
  mocks.execFileAsyncMock.mockReset()
  mocks.ghExecFileAsyncMock.mockReset()
  mocks.getOwnerRepoMock.mockReset()
  mocks.getIssueOwnerRepoMock.mockReset()
  mocks.getOwnerRepoForRemoteMock.mockReset()
  mocks.getOwnerRepoForRemoteMock.mockImplementation(
    async (repoPath: string, remoteName: string, connectionId?: string | null, opts = {}) =>
      remoteName === 'origin' ? mocks.getOwnerRepoMock(repoPath, connectionId, opts) : null
  )
  mocks.resolvePRRepositoryCandidatesMock.mockReset()
  mocks.resolvePRRepositoryCandidatesMock.mockImplementation(async (repoPath, connectionId) => {
    const origin = await mocks.getOwnerRepoMock(repoPath, connectionId)
    return { candidates: origin ? [origin] : [], headRepo: origin }
  })
  mocks.getRemoteUrlForRepoMock.mockReset()
  mocks.gitExecFileAsyncMock.mockReset()
  mocks.rateLimitGuardMock.mockReset()
  mocks.rateLimitGuardMock.mockReturnValue({ blocked: false })
  mocks.noteRateLimitSpendMock.mockReset()
  mocks.acquireMock.mockReset()
  mocks.releaseMock.mockReset()
  mocks.acquireMock.mockResolvedValue(undefined)
  _resetOwnerRepoCache()
  _resetMergeQueueCacheForTests()
  _resetPRStackSummaryCacheForTests()
  __resetPRConflictSummaryCachesForTests()
}
