import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createGitHubPullRequestMock,
  createGitLabMergeRequestMock,
  createAzureDevOpsPullRequestMock,
  createGiteaPullRequestMock,
  isAzureDevOpsReviewCreationAuthenticatedMock,
  isGiteaReviewCreationAuthenticatedMock,
  getRepoSlugMock,
  getProjectSlugMock,
  getBitbucketRepoSlugMock,
  getAzureDevOpsRepoSlugMock,
  getGiteaRepoSlugMock,
  getHostedReviewForBranchMock,
  ghExecFileAsyncMock,
  glabExecFileAsyncMock,
  gitExecFileAsyncMock,
  getUpstreamStatusMock,
  getEnterpriseGitHubRepoSlugMock
} = vi.hoisted(() => ({
  createGitHubPullRequestMock: vi.fn(),
  createGitLabMergeRequestMock: vi.fn(),
  createAzureDevOpsPullRequestMock: vi.fn(),
  createGiteaPullRequestMock: vi.fn(),
  isAzureDevOpsReviewCreationAuthenticatedMock: vi.fn(),
  isGiteaReviewCreationAuthenticatedMock: vi.fn(),
  getRepoSlugMock: vi.fn(),
  getProjectSlugMock: vi.fn(),
  getBitbucketRepoSlugMock: vi.fn(),
  getAzureDevOpsRepoSlugMock: vi.fn(),
  getGiteaRepoSlugMock: vi.fn(),
  getHostedReviewForBranchMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  glabExecFileAsyncMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  getUpstreamStatusMock: vi.fn(),
  getEnterpriseGitHubRepoSlugMock: vi.fn()
}))

vi.mock('../github/client', () => ({
  createGitHubPullRequest: createGitHubPullRequestMock,
  getRepoSlug: getRepoSlugMock,
  getPRForBranch: vi.fn()
}))

vi.mock('../github/github-enterprise-repository', () => ({
  getEnterpriseGitHubRepoSlug: getEnterpriseGitHubRepoSlugMock
}))

vi.mock('../gitlab/client', () => ({
  getProjectSlug: getProjectSlugMock,
  getMergeRequestForBranch: vi.fn(),
  getMergeRequest: vi.fn()
}))

vi.mock('../gitlab/merge-request-creation', () => ({
  createGitLabMergeRequest: createGitLabMergeRequestMock
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
  createAzureDevOpsPullRequest: createAzureDevOpsPullRequestMock,
  isAzureDevOpsReviewCreationAuthenticated: isAzureDevOpsReviewCreationAuthenticatedMock
}))

vi.mock('../gitea/client', () => ({
  getGiteaRepoSlug: getGiteaRepoSlugMock,
  getGiteaPullRequestForBranch: vi.fn(),
  getGiteaPullRequest: vi.fn()
}))

vi.mock('../gitea/pull-request-creation', () => ({
  createGiteaPullRequest: createGiteaPullRequestMock,
  isGiteaReviewCreationAuthenticated: isGiteaReviewCreationAuthenticatedMock
}))

vi.mock('../github/gh-utils', () => ({
  acquire: vi.fn(),
  release: vi.fn(),
  ghExecFileAsync: ghExecFileAsyncMock,
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../gitlab/gl-utils', () => ({
  acquire: vi.fn(),
  release: vi.fn(),
  glabExecFileAsync: glabExecFileAsyncMock,
  glabRepoExecOptions: (repoPath: string, connectionId?: string | null) =>
    connectionId ? {} : { cwd: repoPath }
}))

vi.mock('../git/upstream', () => ({
  getUpstreamStatus: getUpstreamStatusMock
}))

vi.mock('./hosted-review', () => ({
  getHostedReviewForBranch: getHostedReviewForBranchMock
}))

import { createHostedReview } from './hosted-review-creation'

import { _resetOriginGitHubApiRepositoryCache } from '../github/github-api-repository'

// Isolate module-level repository identities between tests.
beforeEach(() => {
  _resetOriginGitHubApiRepositoryCache()
})

function resetMocks(): void {
  for (const mock of [
    createGitHubPullRequestMock,
    createGitLabMergeRequestMock,
    createAzureDevOpsPullRequestMock,
    createGiteaPullRequestMock,
    isAzureDevOpsReviewCreationAuthenticatedMock,
    isGiteaReviewCreationAuthenticatedMock,
    getRepoSlugMock,
    getProjectSlugMock,
    getBitbucketRepoSlugMock,
    getAzureDevOpsRepoSlugMock,
    getGiteaRepoSlugMock,
    getHostedReviewForBranchMock,
    ghExecFileAsyncMock,
    glabExecFileAsyncMock,
    gitExecFileAsyncMock,
    getUpstreamStatusMock,
    getEnterpriseGitHubRepoSlugMock
  ]) {
    mock.mockReset()
  }
}

function mockGitHubProvider(): void {
  getProjectSlugMock.mockResolvedValue(null)
  getRepoSlugMock.mockResolvedValue({ owner: 'acme', repo: 'orca' })
  getBitbucketRepoSlugMock.mockResolvedValue(null)
  getAzureDevOpsRepoSlugMock.mockResolvedValue(null)
  getGiteaRepoSlugMock.mockResolvedValue(null)
  getEnterpriseGitHubRepoSlugMock.mockResolvedValue(null)
}

// #8312: authenticated GHES detection supplies its custom host.
function mockGitHubEnterpriseProvider(): void {
  getProjectSlugMock.mockResolvedValue(null)
  getRepoSlugMock.mockResolvedValue({
    owner: 'acme',
    repo: 'orca',
    host: 'github.acme-corp.com'
  })
  getBitbucketRepoSlugMock.mockResolvedValue(null)
  getAzureDevOpsRepoSlugMock.mockResolvedValue(null)
  getGiteaRepoSlugMock.mockResolvedValue(null)
  getEnterpriseGitHubRepoSlugMock.mockResolvedValue({
    owner: 'acme',
    repo: 'orca',
    host: 'github.acme-corp.com'
  })
}

function mockGitLabProvider(): void {
  getProjectSlugMock.mockResolvedValue({ host: 'gitlab.com', path: 'acme/orca' })
  getRepoSlugMock.mockResolvedValue(null)
  getBitbucketRepoSlugMock.mockResolvedValue(null)
  getAzureDevOpsRepoSlugMock.mockResolvedValue(null)
  getGiteaRepoSlugMock.mockResolvedValue(null)
}

function mockAzureDevOpsProvider(): void {
  getProjectSlugMock.mockResolvedValue(null)
  getRepoSlugMock.mockResolvedValue(null)
  getBitbucketRepoSlugMock.mockResolvedValue(null)
  getAzureDevOpsRepoSlugMock.mockResolvedValue({
    host: 'dev.azure.com',
    project: 'Project',
    repository: 'orca',
    apiBaseUrl: 'https://dev.azure.com/acme/Project',
    webBaseUrl: 'https://dev.azure.com/acme/Project/_git/orca'
  })
  getGiteaRepoSlugMock.mockResolvedValue(null)
}

function mockGiteaProvider(): void {
  getProjectSlugMock.mockResolvedValue(null)
  getRepoSlugMock.mockResolvedValue(null)
  getBitbucketRepoSlugMock.mockResolvedValue(null)
  getAzureDevOpsRepoSlugMock.mockResolvedValue(null)
  getGiteaRepoSlugMock.mockResolvedValue({
    host: 'git.example.com',
    owner: 'acme',
    repo: 'orca',
    apiBaseUrl: 'https://git.example.com/api/v1',
    webBaseUrl: 'https://git.example.com'
  })
}

describe('createHostedReview', () => {
  beforeEach(() => {
    resetMocks()

    mockGitHubProvider()
    getHostedReviewForBranchMock.mockResolvedValue(null)
    ghExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    glabExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    getUpstreamStatusMock.mockResolvedValue({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 0,
      behind: 0
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        return { stdout: 'feature\n', stderr: '' }
      }
      if (args[0] === 'status') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        return { stdout: 'abc refs/remotes/origin/main\n', stderr: '' }
      }
      if (args[0] === 'log' && args.includes('--pretty=%s')) {
        return { stdout: 'Feature title\n', stderr: '' }
      }
      if (args[0] === 'log') {
        return { stdout: '- Feature title\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    createGitHubPullRequestMock.mockResolvedValue({
      ok: true,
      number: 12,
      url: 'https://github.com/acme/orca/pull/12'
    })
    createGitLabMergeRequestMock.mockResolvedValue({
      ok: true,
      number: 44,
      url: 'https://gitlab.com/acme/orca/-/merge_requests/44'
    })
    createAzureDevOpsPullRequestMock.mockResolvedValue({
      ok: true,
      number: 88,
      url: 'https://dev.azure.com/acme/Project/_git/orca/pullrequest/88'
    })
    createGiteaPullRequestMock.mockResolvedValue({
      ok: true,
      number: 19,
      url: 'https://git.example.com/acme/orca/pulls/19'
    })
    isAzureDevOpsReviewCreationAuthenticatedMock.mockReturnValue(true)
    isGiteaReviewCreationAuthenticatedMock.mockReturnValue(true)
  })

  it('revalidates ahead commits before creating a GitHub pull request', async () => {
    getUpstreamStatusMock.mockResolvedValue({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 1,
      behind: 0
    })

    await expect(
      createHostedReview(
        '/repo',
        {
          provider: 'github',
          base: 'main',
          head: 'feature',
          title: 'Feature'
        },
        'local'
      )
    ).resolves.toEqual({
      ok: false,
      code: 'validation',
      error: 'Create PR failed: push this branch before creating a pull request.'
    })
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
  })

  it('rejects creation when the selected head is no longer checked out', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        return { stdout: 'other-branch\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      createHostedReview(
        '/repo',
        {
          provider: 'github',
          base: 'main',
          head: 'feature',
          title: 'Feature'
        },
        'local'
      )
    ).resolves.toEqual({
      ok: false,
      code: 'validation',
      error: 'Create PR failed: switch back to the selected branch before creating a pull request.'
    })
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
  })

  it('blocks creation with actionable copy when the submitted base is local-only', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        return { stdout: 'feature\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        throw Object.assign(new Error('missing ref'), { code: 1 })
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      createHostedReview(
        '/repo',
        {
          provider: 'github',
          base: 'stacked-parent',
          head: 'feature',
          title: 'Feature'
        },
        'local'
      )
    ).resolves.toEqual({
      ok: false,
      code: 'validation',
      error:
        'Create PR failed: the base branch "stacked-parent" hasn\'t been pushed to the remote. Choose a pushed base or push it first.'
    })
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
  })

  it('creates the pull request after fresh main-process validation passes', async () => {
    await expect(
      createHostedReview(
        '/repo',
        {
          provider: 'github',
          base: 'main',
          head: 'feature',
          title: 'Feature'
        },
        'local'
      )
    ).resolves.toEqual({
      ok: true,
      number: 12,
      url: 'https://github.com/acme/orca/pull/12'
    })
    expect(createGitHubPullRequestMock).toHaveBeenCalledOnce()
  })

  it('routes local WSL git and GitHub review creation through the selected runtime', async () => {
    await expect(
      createHostedReview(
        '/repo',
        {
          provider: 'github',
          base: 'main',
          head: 'feature',
          title: 'Feature'
        },
        'local',
        { localGitExecOptions: { wslDistro: 'Ubuntu' } }
      )
    ).resolves.toEqual({
      ok: true,
      number: 12,
      url: 'https://github.com/acme/orca/pull/12'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: '/repo',
      wslDistro: 'Ubuntu'
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['status', '--porcelain', '-z'],
      expect.objectContaining({ cwd: '/repo', wslDistro: 'Ubuntu' })
    )
    expect(getUpstreamStatusMock).toHaveBeenCalledWith('/repo', undefined, {
      wslDistro: 'Ubuntu'
    })
    expect(getProjectSlugMock).toHaveBeenCalledWith('/repo', null, {
      localGitExecOptions: { wslDistro: 'Ubuntu' }
    })
    expect(getRepoSlugMock).toHaveBeenCalledWith('/repo', null, {
      localGitExecOptions: { wslDistro: 'Ubuntu' }
    })
    expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/repo',
        branch: 'feature',
        localGitExecOptions: { wslDistro: 'Ubuntu' },
        // Use active pacing so reviews opened outside Orca promptly disable Create.
        active: true
      })
    )
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['auth', 'status', '--hostname', 'github.com'],
      { cwd: '/repo', wslDistro: 'Ubuntu', host: 'github.com' }
    )
    expect(createGitHubPullRequestMock).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ provider: 'github', head: 'feature' }),
      'local',
      { localGitExecOptions: { wslDistro: 'Ubuntu' } }
    )
  })

  it('creates a pull request on a GitHub Enterprise Server remote (#8312)', async () => {
    mockGitHubEnterpriseProvider()

    await expect(
      createHostedReview(
        '/repo',
        {
          provider: 'github',
          base: 'main',
          head: 'feature',
          title: 'Feature'
        },
        'local'
      )
    ).resolves.toEqual({
      ok: true,
      number: 12,
      url: 'https://github.com/acme/orca/pull/12'
    })

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(createGitHubPullRequestMock).toHaveBeenCalled()
    expect(createGiteaPullRequestMock).not.toHaveBeenCalled()
  })

  it('creates a GitLab merge request after fresh main-process validation passes', async () => {
    mockGitLabProvider()

    await expect(
      createHostedReview(
        '/repo',
        {
          provider: 'gitlab',
          base: 'main',
          head: 'feature',
          title: 'Feature'
        },
        'local'
      )
    ).resolves.toEqual({
      ok: true,
      number: 44,
      url: 'https://gitlab.com/acme/orca/-/merge_requests/44'
    })

    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['auth', 'status', '--hostname', 'gitlab.com'],
      { cwd: '/repo' }
    )
    expect(createGitLabMergeRequestMock).toHaveBeenCalledWith(
      '/repo',
      {
        provider: 'gitlab',
        base: 'main',
        head: 'feature',
        title: 'Feature'
      },
      'local'
    )
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
  })

  it('creates an Azure DevOps pull request after fresh main-process validation passes', async () => {
    mockAzureDevOpsProvider()

    await expect(
      createHostedReview(
        '/repo',
        {
          provider: 'azure-devops',
          base: 'main',
          head: 'feature',
          title: 'Feature'
        },
        'local'
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
        head: 'feature',
        title: 'Feature'
      },
      'local'
    )
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
    expect(createGitLabMergeRequestMock).not.toHaveBeenCalled()
  })

  it('creates a Gitea pull request after fresh main-process validation passes', async () => {
    mockGiteaProvider()

    await expect(
      createHostedReview(
        '/repo',
        {
          provider: 'gitea',
          base: 'main',
          head: 'feature',
          title: 'Feature'
        },
        'local'
      )
    ).resolves.toEqual({
      ok: true,
      number: 19,
      url: 'https://git.example.com/acme/orca/pulls/19'
    })

    expect(createGiteaPullRequestMock).toHaveBeenCalledWith(
      '/repo',
      {
        provider: 'gitea',
        base: 'main',
        head: 'feature',
        title: 'Feature'
      },
      'local'
    )
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
    expect(createGitLabMergeRequestMock).not.toHaveBeenCalled()
  })

  it('returns the existing review instead of creating a duplicate', async () => {
    getHostedReviewForBranchMock.mockResolvedValue({
      provider: 'github',
      number: 31,
      title: 'Existing feature',
      state: 'open',
      url: 'https://github.com/acme/orca/pull/31',
      status: 'pending',
      updatedAt: '2026-05-15T00:00:00.000Z',
      mergeable: 'UNKNOWN'
    })

    await expect(
      createHostedReview(
        '/repo',
        {
          provider: 'github',
          base: 'main',
          head: 'feature',
          title: 'Feature'
        },
        'local'
      )
    ).resolves.toEqual({
      ok: false,
      code: 'already_exists',
      error: 'A pull request already exists for this branch.',
      existingReview: {
        number: 31,
        url: 'https://github.com/acme/orca/pull/31'
      }
    })
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
  })
})
