import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createGitHubPullRequestMock,
  createGitLabMergeRequestMock,
  createAzureDevOpsPullRequestMock,
  createGiteaPullRequestMock,
  getAzureDevOpsRepoSlugMock,
  getBitbucketRepoSlugMock,
  getGiteaRepoSlugMock,
  getMergeRequestForBranchMock,
  getProjectSlugMock,
  getPRForBranchOutcomeMock,
  getRepoSlugMock
} = vi.hoisted(() => ({
  createGitHubPullRequestMock: vi.fn(),
  createGitLabMergeRequestMock: vi.fn(),
  createAzureDevOpsPullRequestMock: vi.fn(),
  createGiteaPullRequestMock: vi.fn(),
  getAzureDevOpsRepoSlugMock: vi.fn(),
  getBitbucketRepoSlugMock: vi.fn(),
  getGiteaRepoSlugMock: vi.fn(),
  getMergeRequestForBranchMock: vi.fn(),
  getProjectSlugMock: vi.fn(),
  getPRForBranchOutcomeMock: vi.fn(),
  getRepoSlugMock: vi.fn()
}))

vi.mock('../gitlab/client', () => ({
  getProjectSlug: getProjectSlugMock,
  getMergeRequestForBranch: getMergeRequestForBranchMock,
  getMergeRequest: vi.fn()
}))

vi.mock('../gitlab/merge-request-creation', () => ({
  createGitLabMergeRequest: createGitLabMergeRequestMock
}))

vi.mock('../github/client', () => ({
  createGitHubPullRequest: createGitHubPullRequestMock,
  getRepoSlug: getRepoSlugMock,
  getPRForBranchOutcome: getPRForBranchOutcomeMock
}))

vi.mock('../bitbucket/client', () => ({
  getBitbucketRepoSlug: getBitbucketRepoSlugMock,
  getBitbucketPullRequestForBranch: vi.fn(),
  getBitbucketPullRequest: vi.fn()
}))

vi.mock('../azure-devops/client', () => ({
  getAzureDevOpsRepoSlug: getAzureDevOpsRepoSlugMock,
  getAzureDevOpsPullRequestForBranch: vi.fn(),
  getAzureDevOpsPullRequest: vi.fn()
}))

vi.mock('../azure-devops/pull-request-creation', () => ({
  createAzureDevOpsPullRequest: createAzureDevOpsPullRequestMock
}))

vi.mock('../gitea/client', () => ({
  getGiteaRepoSlug: getGiteaRepoSlugMock,
  getGiteaPullRequestForBranch: vi.fn(),
  getGiteaPullRequest: vi.fn()
}))

vi.mock('../gitea/pull-request-creation', () => ({
  createGiteaPullRequest: createGiteaPullRequestMock
}))

import {
  FORGE_PROVIDERS,
  detectHostedReviewProvider,
  getForgeProviderById,
  getForgeProviderForRepository
} from './forge-provider'

describe('forge provider interface', () => {
  beforeEach(() => {
    createGitHubPullRequestMock.mockReset()
    createGitLabMergeRequestMock.mockReset()
    createAzureDevOpsPullRequestMock.mockReset()
    createGiteaPullRequestMock.mockReset()
    getAzureDevOpsRepoSlugMock.mockReset()
    getBitbucketRepoSlugMock.mockReset()
    getGiteaRepoSlugMock.mockReset()
    getMergeRequestForBranchMock.mockReset()
    getProjectSlugMock.mockReset()
    getPRForBranchOutcomeMock.mockReset()
    getRepoSlugMock.mockReset()
  })

  it('preserves the existing hosted provider detection order', async () => {
    getProjectSlugMock.mockResolvedValue({ host: 'gitlab.com', path: 'team/orca' })
    getRepoSlugMock.mockResolvedValue({ owner: 'team', repo: 'orca' })

    await expect(detectHostedReviewProvider({ repoPath: '/repo' })).resolves.toBe('gitlab')
    await expect(getForgeProviderForRepository({ repoPath: '/repo' })).resolves.toMatchObject({
      id: 'gitlab'
    })
    expect(getRepoSlugMock).not.toHaveBeenCalled()
  })

  it('keeps review creation capability scoped to providers with creation support', async () => {
    expect(
      FORGE_PROVIDERS.map((provider) => [provider.id, provider.supportsReviewCreation])
    ).toEqual([
      ['gitlab', true],
      ['github', true],
      ['bitbucket', false],
      ['azure-devops', true],
      ['gitea', true]
    ])
    createGitHubPullRequestMock.mockResolvedValue({
      ok: true,
      number: 12,
      url: 'https://github.com/team/orca/pull/12'
    })

    const provider = getForgeProviderById('github')
    await expect(
      provider.createReview?.('/repo', {
        provider: 'github',
        base: 'main',
        head: 'feature/provider-interface',
        title: 'Add provider interface'
      })
    ).resolves.toEqual({
      ok: true,
      number: 12,
      url: 'https://github.com/team/orca/pull/12'
    })
    expect(createGitHubPullRequestMock).toHaveBeenCalledWith('/repo', {
      provider: 'github',
      base: 'main',
      head: 'feature/provider-interface',
      title: 'Add provider interface'
    })
  })

  it('routes GitLab review creation through the shared provider contract', async () => {
    createGitLabMergeRequestMock.mockResolvedValue({
      ok: true,
      number: 44,
      url: 'https://gitlab.com/team/orca/-/merge_requests/44'
    })

    const provider = getForgeProviderById('gitlab')
    await expect(
      provider.createReview?.(
        '/repo',
        {
          provider: 'gitlab',
          base: 'main',
          head: 'feature/provider-interface',
          title: 'Add provider interface'
        },
        'ssh-1'
      )
    ).resolves.toEqual({
      ok: true,
      number: 44,
      url: 'https://gitlab.com/team/orca/-/merge_requests/44'
    })
    expect(createGitLabMergeRequestMock).toHaveBeenCalledWith(
      '/repo',
      {
        provider: 'gitlab',
        base: 'main',
        head: 'feature/provider-interface',
        title: 'Add provider interface'
      },
      'ssh-1'
    )
  })

  it('routes Azure DevOps review creation through the shared provider contract', async () => {
    createAzureDevOpsPullRequestMock.mockResolvedValue({
      ok: true,
      number: 88,
      url: 'https://dev.azure.com/acme/Project/_git/orca/pullrequest/88'
    })

    const provider = getForgeProviderById('azure-devops')
    await expect(
      provider.createReview?.(
        '/repo',
        {
          provider: 'azure-devops',
          base: 'main',
          head: 'feature/provider-interface',
          title: 'Add provider interface'
        },
        'ssh-1'
      )
    ).resolves.toEqual({
      ok: true,
      number: 88,
      url: 'https://dev.azure.com/acme/Project/_git/orca/pullrequest/88'
    })
    expect(createAzureDevOpsPullRequestMock).toHaveBeenCalledWith(
      '/repo',
      {
        provider: 'azure-devops',
        base: 'main',
        head: 'feature/provider-interface',
        title: 'Add provider interface'
      },
      'ssh-1'
    )
  })

  it('routes Gitea review creation through the shared provider contract', async () => {
    createGiteaPullRequestMock.mockResolvedValue({
      ok: true,
      number: 19,
      url: 'https://git.example.com/team/orca/pulls/19'
    })

    const provider = getForgeProviderById('gitea')
    await expect(
      provider.createReview?.(
        '/repo',
        {
          provider: 'gitea',
          base: 'main',
          head: 'feature/provider-interface',
          title: 'Add provider interface'
        },
        'ssh-1'
      )
    ).resolves.toEqual({
      ok: true,
      number: 19,
      url: 'https://git.example.com/team/orca/pulls/19'
    })
    expect(createGiteaPullRequestMock).toHaveBeenCalledWith(
      '/repo',
      {
        provider: 'gitea',
        base: 'main',
        head: 'feature/provider-interface',
        title: 'Add provider interface'
      },
      'ssh-1'
    )
  })

  it('adapts GitHub branch lookup through the shared provider contract', async () => {
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      fetchedAt: 1,
      pr: {
        number: 7,
        title: 'Provider branch',
        state: 'open',
        url: 'https://github.com/team/orca/pull/7',
        checksStatus: 'success',
        updatedAt: '2026-05-29T00:00:00.000Z',
        mergeable: 'MERGEABLE'
      }
    })

    await expect(
      getForgeProviderById('github').getReviewForBranch({
        repoPath: '/repo',
        connectionId: 'ssh-1',
        branch: '',
        fallbackReviewNumber: 7
      })
    ).resolves.toMatchObject({
      provider: 'github',
      number: 7,
      status: 'success'
    })
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith('/repo', '', null, 'ssh-1', 7, {
      acceptMergedFallbackPR: true,
      currentHeadOid: null
    })
  })

  it('passes the worktree HEAD oid through to the GitHub lookup', async () => {
    getPRForBranchOutcomeMock.mockResolvedValue({ kind: 'no-pr', fetchedAt: 1 })

    await getForgeProviderById('github').getReviewForBranch({
      repoPath: '/repo',
      connectionId: null,
      branch: 'feature/x',
      githubCurrentHeadOid: 'abc1234'
    })

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith('/repo', 'feature/x', null, null, null, {
      currentHeadOid: 'abc1234'
    })
  })

  it('returns null for a confirmed GitHub no-pr lookup', async () => {
    getPRForBranchOutcomeMock.mockResolvedValue({ kind: 'no-pr', fetchedAt: 1 })

    await expect(
      getForgeProviderById('github').getReviewForBranch({
        repoPath: '/repo',
        connectionId: null,
        branch: 'feature/x'
      })
    ).resolves.toBeNull()
  })

  it('throws on a GitHub upstream error instead of reporting no review', async () => {
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'upstream-error',
      errorType: 'network',
      message: 'connection reset',
      fetchedAt: 1
    })

    await expect(
      getForgeProviderById('github').getReviewForBranch({
        repoPath: '/repo',
        connectionId: null,
        branch: 'feature/x'
      })
    ).rejects.toThrow(/network/)
  })
})
