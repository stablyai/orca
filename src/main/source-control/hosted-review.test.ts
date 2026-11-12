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

vi.mock('../github/client', () => ({
  getRepoSlug: getRepoSlugMock,
  getPRForBranchOutcome: getPRForBranchOutcomeMock,
  getGitHubPRLookupRateLimitBlock: vi.fn(async () => null),
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

  it('refreshes a self-managed GitLab MR through the provider while old metadata is pending', async () => {
    getProjectSlugMock.mockResolvedValue({ host: 'gitlab.example.test', path: 'g/p' })
    const old = {
      number: 7,
      title: 'MR',
      state: 'opened',
      url: 'https://gitlab.example.test/g/p/-/merge_requests/7',
      pipelineStatus: 'success',
      updatedAt: '2026-05-10T00:00:00.000Z',
      mergeable: 'MERGEABLE'
    }
    let finishOld: (value: typeof old) => void = () => {}
    const pending = new Promise<typeof old>((resolve) => {
      finishOld = resolve
    })
    let started!: () => void
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    getMergeRequestForBranchMock.mockImplementation(
      (
        _repo: string,
        _branch: string,
        _linked: unknown,
        connectionId?: string | null,
        options?: { userRefresh?: boolean }
      ) => {
        started()
        if (connectionId !== 'ssh-1') {
          return Promise.resolve(null)
        }
        return options?.userRefresh ? Promise.resolve({ ...old, state: 'merged' }) : pending
      }
    )
    const input = {
      repoPath: '/repo',
      executionHostId: 'ssh:ssh-1',
      branch: 'feature',
      force: true
    } as const
    const before = getHostedReviewForBranch(input)
    await requestStarted
    const click = getHostedReviewForBranch({ ...input, userRefresh: true })
    finishOld(old)
    await before
    await expect(click).resolves.toMatchObject({ provider: 'gitlab', state: 'merged', number: 7 })
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

  it('falls through to GitHub when origin is not GitLab', async () => {
    getProjectSlugMock.mockResolvedValue(null)
    getRepoSlugMock.mockResolvedValue({ owner: 'o', repo: 'r' })
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      fetchedAt: 1,
      pr: {
        number: 3,
        title: 'GitHub branch',
        state: 'open',
        url: 'https://github.com/o/r/pull/3',
        checksStatus: 'pending',
        updatedAt: '2026-05-10T00:00:00.000Z',
        mergeable: 'UNKNOWN'
      }
    })

    await expect(
      getHostedReviewForBranch({
        executionHostId: 'local',
        repoPath: '/repo',
        branch: 'feature',
        linkedGitHubPR: 3
      })
    ).resolves.toMatchObject({
      provider: 'github',
      number: 3,
      status: 'pending'
    })
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith('/repo', 'feature', 3, null, null, {
      currentHeadOid: null
    })
  })

  it('routes local WSL project branch lookup through provider detection and the selected provider', async () => {
    getProjectSlugMock.mockResolvedValue(null)
    getRepoSlugMock.mockResolvedValue(null)
    getBitbucketRepoSlugMock.mockResolvedValue({ workspace: 'team', repoSlug: 'orca' })
    getBitbucketPullRequestForBranchMock.mockResolvedValue({
      number: 22,
      title: 'Bitbucket WSL branch',
      state: 'open',
      url: 'https://bitbucket.org/team/orca/pull-requests/22',
      status: 'pending',
      updatedAt: '2026-06-16T00:00:00.000Z',
      mergeable: 'UNKNOWN'
    })

    await expect(
      getHostedReviewForBranch({
        executionHostId: 'local',
        repoPath: '/repo',
        branch: 'feature/wsl',
        linkedBitbucketPR: 22,
        localGitExecOptions: { wslDistro: 'Ubuntu' }
      })
    ).resolves.toMatchObject({
      provider: 'bitbucket',
      number: 22,
      status: 'pending'
    })

    const executionOptions = { localGitExecOptions: { wslDistro: 'Ubuntu' } }
    expect(getProjectSlugMock).toHaveBeenCalledWith('/repo', null, executionOptions)
    expect(getRepoSlugMock).toHaveBeenCalledWith('/repo', null, executionOptions)
    expect(getBitbucketRepoSlugMock).toHaveBeenCalledWith('/repo', null, executionOptions)
    expect(getBitbucketPullRequestForBranchMock).toHaveBeenCalledWith(
      '/repo',
      'feature/wsl',
      22,
      null,
      executionOptions
    )
  })

  it('uses fallback GitHub PR when branch is empty', async () => {
    getProjectSlugMock.mockResolvedValue(null)
    getRepoSlugMock.mockResolvedValue({ owner: 'o', repo: 'r' })
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      fetchedAt: 1,
      pr: {
        number: 42,
        title: 'Detached GitHub branch',
        state: 'open',
        url: 'https://github.com/o/r/pull/42',
        checksStatus: 'success',
        updatedAt: '2026-05-10T00:00:00.000Z',
        mergeable: 'MERGEABLE'
      }
    })

    await expect(
      getHostedReviewForBranch({
        executionHostId: 'local',
        repoPath: '/repo',
        branch: '',
        fallbackGitHubPR: 42
      })
    ).resolves.toMatchObject({
      provider: 'github',
      number: 42,
      status: 'success'
    })
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith('/repo', '', null, null, 42, {
      acceptMergedFallbackPR: true,
      currentHeadOid: null
    })
  })
})
