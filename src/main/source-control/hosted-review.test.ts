import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getHostedReviewForBranch } from './hosted-review'
import { __resetHostedReviewBranchCacheForTests } from './hosted-review-branch-cache'

const {
  getProjectSlugMock,
  getMergeRequestForBranchMock,
  getRepoSlugMock,
  getPRForBranchOutcomeMock,
  getBitbucketRepoSlugMock,
  getBitbucketPullRequestForBranchMock,
  getAzureDevOpsRepoSlugMock,
  getAzureDevOpsPullRequestForBranchMock,
  getGiteaRepoSlugMock,
  getGiteaPullRequestForBranchMock
} = vi.hoisted(() => ({
  getProjectSlugMock: vi.fn(),
  getMergeRequestForBranchMock: vi.fn(),
  getRepoSlugMock: vi.fn(),
  getPRForBranchOutcomeMock: vi.fn(),
  getBitbucketRepoSlugMock: vi.fn(),
  getBitbucketPullRequestForBranchMock: vi.fn(),
  getAzureDevOpsRepoSlugMock: vi.fn(),
  getAzureDevOpsPullRequestForBranchMock: vi.fn(),
  getGiteaRepoSlugMock: vi.fn(),
  getGiteaPullRequestForBranchMock: vi.fn()
}))

vi.mock('../gitlab/merge-requests/merge-request-lookup', () => ({
  getProjectSlug: getProjectSlugMock,
  getMergeRequestForBranch: getMergeRequestForBranchMock,
  getMergeRequestForBranchOrThrow: getMergeRequestForBranchMock,
  getMergeRequest: vi.fn()
}))

vi.mock('../github/client/fetch/repo-slug-upstream', () => ({
  getRepoSlug: getRepoSlugMock
}))

vi.mock('../github/client/lookup/pr-for-branch-outcome', () => ({
  getPRForBranchOutcome: getPRForBranchOutcomeMock
}))

vi.mock('../github/client/lookup/pr-lookup-rate-limit', () => ({
  getGitHubPRLookupRateLimitBlock: vi.fn(async () => null)
}))

vi.mock('../github/client/create/create-github-pull-request', () => ({
  createGitHubPullRequest: vi.fn()
}))

vi.mock('../bitbucket/client', () => ({
  getBitbucketRepoSlug: getBitbucketRepoSlugMock,
  getBitbucketPullRequestForBranch: getBitbucketPullRequestForBranchMock,
  // Preserve provider errors as unavailable rather than false review absence.
  getBitbucketPullRequestForBranchOrThrow: getBitbucketPullRequestForBranchMock,
  getBitbucketPullRequest: vi.fn()
}))

vi.mock('../azure-devops/client', () => ({
  getAzureDevOpsRepoSlug: getAzureDevOpsRepoSlugMock,
  getAzureDevOpsPullRequestForBranch: getAzureDevOpsPullRequestForBranchMock,
  // Preserve provider errors as unavailable rather than false review absence.
  getAzureDevOpsPullRequestForBranchOrThrow: getAzureDevOpsPullRequestForBranchMock,
  getAzureDevOpsPullRequest: vi.fn()
}))

vi.mock('../gitea/client', () => ({
  getGiteaRepoSlug: getGiteaRepoSlugMock,
  getGiteaPullRequestForBranch: getGiteaPullRequestForBranchMock,
  // Preserve provider errors as unavailable rather than false review absence.
  getGiteaPullRequestForBranchOrThrow: getGiteaPullRequestForBranchMock,
  getGiteaPullRequest: vi.fn()
}))

describe('getHostedReviewForBranch', () => {
  beforeEach(() => {
    getProjectSlugMock.mockReset()
    getMergeRequestForBranchMock.mockReset()
    getRepoSlugMock.mockReset()
    getPRForBranchOutcomeMock.mockReset()
    getBitbucketRepoSlugMock.mockReset()
    getBitbucketPullRequestForBranchMock.mockReset()
    getAzureDevOpsRepoSlugMock.mockReset()
    getAzureDevOpsPullRequestForBranchMock.mockReset()
    getGiteaRepoSlugMock.mockReset()
    getGiteaPullRequestForBranchMock.mockReset()
    // Clear process-wide answers so one test cannot satisfy another's lookup.
    __resetHostedReviewBranchCacheForTests()
  })

  it('maps GitLab merge requests into the hosted review surface', async () => {
    getProjectSlugMock.mockResolvedValue({ host: 'gitlab.com', path: 'g/p' })
    const mr = {
      number: 7,
      title: 'GitLab branch',
      state: 'opened',
      url: 'https://gitlab.com/g/p/-/merge_requests/7',
      pipelineStatus: 'success',
      updatedAt: '2026-05-10T00:00:00.000Z',
      mergeable: 'MERGEABLE'
    }
    getMergeRequestForBranchMock.mockImplementation(
      (repo: string, branch: string, _linked: unknown, connectionId?: string | null) =>
        Promise.resolve(
          repo === '/repo' && branch === 'feature' && connectionId === 'ssh-1' ? mr : null
        )
    )

    await expect(
      getHostedReviewForBranch({
        repoPath: '/repo',
        executionHostId: 'ssh:ssh-1',
        branch: 'refs/heads/feature'
      })
    ).resolves.toEqual({
      provider: 'gitlab',
      number: 7,
      title: 'GitLab branch',
      state: 'open',
      url: 'https://gitlab.com/g/p/-/merge_requests/7',
      status: 'success',
      updatedAt: '2026-05-10T00:00:00.000Z',
      mergeable: 'MERGEABLE'
    })
    expect(getProjectSlugMock).toHaveBeenCalledWith('/repo', 'ssh-1')
    expect(getPRForBranchOutcomeMock).not.toHaveBeenCalled()
  })
})
