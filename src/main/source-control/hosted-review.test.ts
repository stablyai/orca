import { beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('../gitlab/client', () => ({
  getProjectSlug: getProjectSlugMock,
  getMergeRequestForBranch: getMergeRequestForBranchMock,
  getMergeRequest: vi.fn()
}))

vi.mock('../github/client', () => ({
  getRepoSlug: getRepoSlugMock,
  getPRForBranchOutcome: getPRForBranchOutcomeMock,
  createGitHubPullRequest: vi.fn()
}))

vi.mock('../bitbucket/client', () => ({
  getBitbucketRepoSlug: getBitbucketRepoSlugMock,
  getBitbucketPullRequestForBranch: getBitbucketPullRequestForBranchMock,
  getBitbucketPullRequest: vi.fn()
}))

vi.mock('../azure-devops/client', () => ({
  getAzureDevOpsRepoSlug: getAzureDevOpsRepoSlugMock,
  getAzureDevOpsPullRequestForBranch: getAzureDevOpsPullRequestForBranchMock,
  getAzureDevOpsPullRequest: vi.fn()
}))

vi.mock('../gitea/client', () => ({
  getGiteaRepoSlug: getGiteaRepoSlugMock,
  getGiteaPullRequestForBranch: getGiteaPullRequestForBranchMock,
  getGiteaPullRequest: vi.fn()
}))

import { getHostedReviewForBranch } from './hosted-review'

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
  })

  it('maps GitLab merge requests into the hosted review surface', async () => {
    getProjectSlugMock.mockResolvedValue({ host: 'gitlab.com', path: 'g/p' })
    getMergeRequestForBranchMock.mockResolvedValue({
      number: 7,
      title: 'GitLab branch',
      state: 'opened',
      url: 'https://gitlab.com/g/p/-/merge_requests/7',
      pipelineStatus: 'success',
      updatedAt: '2026-05-10T00:00:00.000Z',
      mergeable: 'MERGEABLE'
    })

    await expect(
      getHostedReviewForBranch({
        repoPath: '/repo',
        connectionId: 'ssh-1',
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
    expect(getMergeRequestForBranchMock).toHaveBeenCalledWith('/repo', 'feature', null, 'ssh-1')
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
        repoPath: '/repo',
        branch: 'feature',
        linkedGitHubPR: 3
      })
    ).resolves.toMatchObject({
      provider: 'github',
      number: 3,
      status: 'pending'
    })
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith('/repo', 'feature', 3, undefined, null, {
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
    expect(getProjectSlugMock).toHaveBeenCalledWith('/repo', undefined, executionOptions)
    expect(getRepoSlugMock).toHaveBeenCalledWith('/repo', undefined, executionOptions)
    expect(getBitbucketRepoSlugMock).toHaveBeenCalledWith('/repo', undefined, executionOptions)
    expect(getBitbucketPullRequestForBranchMock).toHaveBeenCalledWith(
      '/repo',
      'feature/wsl',
      22,
      undefined,
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
        repoPath: '/repo',
        branch: '',
        fallbackGitHubPR: 42
      })
    ).resolves.toMatchObject({
      provider: 'github',
      number: 42,
      status: 'success'
    })
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith('/repo', '', null, undefined, 42, {
      acceptMergedFallbackPR: true,
      currentHeadOid: null
    })
  })

  it('falls through to Bitbucket when origin is not GitLab or GitHub', async () => {
    getProjectSlugMock.mockResolvedValue(null)
    getRepoSlugMock.mockResolvedValue(null)
    getBitbucketRepoSlugMock.mockResolvedValue({ workspace: 'team', repoSlug: 'orca' })
    getBitbucketPullRequestForBranchMock.mockResolvedValue({
      number: 11,
      title: 'Bitbucket branch',
      state: 'open',
      url: 'https://bitbucket.org/team/orca/pull-requests/11',
      status: 'success',
      updatedAt: '2026-05-10T00:00:00.000Z',
      mergeable: 'UNKNOWN',
      headSha: 'abc123'
    })

    await expect(
      getHostedReviewForBranch({
        repoPath: '/repo',
        connectionId: 'ssh-1',
        branch: 'feature/bitbucket',
        linkedBitbucketPR: 11
      })
    ).resolves.toEqual({
      provider: 'bitbucket',
      number: 11,
      title: 'Bitbucket branch',
      state: 'open',
      url: 'https://bitbucket.org/team/orca/pull-requests/11',
      status: 'success',
      updatedAt: '2026-05-10T00:00:00.000Z',
      mergeable: 'UNKNOWN',
      headSha: 'abc123'
    })
    expect(getBitbucketRepoSlugMock).toHaveBeenCalledWith('/repo', 'ssh-1')
    expect(getBitbucketPullRequestForBranchMock).toHaveBeenCalledWith(
      '/repo',
      'feature/bitbucket',
      11,
      'ssh-1'
    )
  })

  it('falls through to Gitea when origin is not another hosted provider', async () => {
    getProjectSlugMock.mockResolvedValue(null)
    getRepoSlugMock.mockResolvedValue(null)
    getBitbucketRepoSlugMock.mockResolvedValue(null)
    getAzureDevOpsRepoSlugMock.mockResolvedValue(null)
    getGiteaRepoSlugMock.mockResolvedValue({
      host: 'git.example.com',
      owner: 'team',
      repo: 'orca'
    })
    getGiteaPullRequestForBranchMock.mockResolvedValue({
      number: 14,
      title: 'Gitea branch',
      state: 'open',
      url: 'https://git.example.com/team/orca/pulls/14',
      status: 'pending',
      updatedAt: '2026-05-15T00:00:00.000Z',
      mergeable: 'MERGEABLE',
      headSha: 'def456'
    })

    await expect(
      getHostedReviewForBranch({
        repoPath: '/repo',
        connectionId: 'ssh-1',
        branch: 'feature/gitea',
        linkedGiteaPR: 14
      })
    ).resolves.toEqual({
      provider: 'gitea',
      number: 14,
      title: 'Gitea branch',
      state: 'open',
      url: 'https://git.example.com/team/orca/pulls/14',
      status: 'pending',
      updatedAt: '2026-05-15T00:00:00.000Z',
      mergeable: 'MERGEABLE',
      headSha: 'def456'
    })
    expect(getGiteaRepoSlugMock).toHaveBeenCalledWith('/repo', 'ssh-1')
    expect(getGiteaPullRequestForBranchMock).toHaveBeenCalledWith(
      '/repo',
      'feature/gitea',
      14,
      'ssh-1'
    )
  })

  it('falls through to Azure DevOps before Gitea when origin is an Azure Repos remote', async () => {
    getProjectSlugMock.mockResolvedValue(null)
    getRepoSlugMock.mockResolvedValue(null)
    getBitbucketRepoSlugMock.mockResolvedValue(null)
    getAzureDevOpsRepoSlugMock.mockResolvedValue({
      host: 'dev.azure.com',
      organization: 'team',
      project: 'Project',
      repository: 'orca'
    })
    getAzureDevOpsPullRequestForBranchMock.mockResolvedValue({
      number: 21,
      title: 'Azure branch',
      state: 'open',
      url: 'https://dev.azure.com/team/Project/_git/orca/pullrequest/21',
      status: 'success',
      updatedAt: '2026-05-16T00:00:00.000Z',
      mergeable: 'MERGEABLE',
      headSha: 'abc123'
    })

    await expect(
      getHostedReviewForBranch({
        repoPath: '/repo',
        connectionId: 'ssh-1',
        branch: 'feature/azure',
        linkedAzureDevOpsPR: 21
      })
    ).resolves.toEqual({
      provider: 'azure-devops',
      number: 21,
      title: 'Azure branch',
      state: 'open',
      url: 'https://dev.azure.com/team/Project/_git/orca/pullrequest/21',
      status: 'success',
      updatedAt: '2026-05-16T00:00:00.000Z',
      mergeable: 'MERGEABLE',
      headSha: 'abc123'
    })
    expect(getAzureDevOpsRepoSlugMock).toHaveBeenCalledWith('/repo', 'ssh-1')
    expect(getAzureDevOpsPullRequestForBranchMock).toHaveBeenCalledWith(
      '/repo',
      'feature/azure',
      21,
      'ssh-1'
    )
    expect(getGiteaRepoSlugMock).not.toHaveBeenCalled()
  })
})
