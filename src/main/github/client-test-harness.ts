import type { GitHubClientMocks } from './client-test-mocks'
import {
  _resetOwnerRepoCache,
  _resetMergeQueueCacheForTests,
  _resetPRStackSummaryCacheForTests,
  __resetTrackedUpstreamBranchCacheForTests
} from './client'
import { __resetPRConflictSummaryCachesForTests } from './conflict-summary'
import { resetMergedPRCommitMembershipCacheForTest } from './merged-pr-commit-membership'
import { __resetRepoDefaultBranchCacheForTests } from '../source-control/repo-default-branch'
import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository'
import { _resetGitHubPRStackCacheForTests } from './github-pr-stack'

// The origin-repository cache is module-level state; reset it so slugs
// resolved by one test cannot leak into the next.
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
  // Why: resolveGitHubRepoExecution probes origin via getOwnerRepoForRemote.
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
  mocks.getSshGitProviderMock.mockReset()
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
  // Why: the #9171 guard caches default-branch resolutions per repoPath;
  // reset so non-open implicit lookups stay order-independent across tests.
  __resetRepoDefaultBranchCacheForTests()
}

export function resetGraphQLRateLimitGuardMocks(mocks: GitHubClientMocks): void {
  resetOriginRepositoryCache()
  mocks.execFileAsyncMock.mockReset()
  mocks.ghExecFileAsyncMock.mockReset()
  mocks.getOwnerRepoMock.mockReset()
  mocks.getIssueOwnerRepoMock.mockReset()
  mocks.getOwnerRepoForRemoteMock.mockReset()
  // Why: getPRComments and mutations resolve origin via getOwnerRepoForRemote.
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
  __resetPRConflictSummaryCachesForTests()
}
