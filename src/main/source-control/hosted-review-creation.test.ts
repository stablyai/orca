/* eslint-disable max-lines -- Why: hosted review creation permutations share large mocks; splitting would hide branch-specific expectations. */
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
  getSshGitProviderMock
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
  getSshGitProviderMock: vi.fn()
}))

vi.mock('../github/client', () => ({
  createGitHubPullRequest: createGitHubPullRequestMock,
  getRepoSlug: getRepoSlugMock,
  getPRForBranch: vi.fn()
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

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

vi.mock('./hosted-review', () => ({
  getHostedReviewForBranch: getHostedReviewForBranchMock
}))

import { createHostedReview, getHostedReviewCreationEligibility } from './hosted-review-creation'

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
    getSshGitProviderMock
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
      createHostedReview('/repo', {
        provider: 'github',
        base: 'main',
        head: 'feature',
        title: 'Feature'
      })
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
      createHostedReview('/repo', {
        provider: 'github',
        base: 'main',
        head: 'feature',
        title: 'Feature'
      })
    ).resolves.toEqual({
      ok: false,
      code: 'validation',
      error: 'Create PR failed: switch back to the selected branch before creating a pull request.'
    })
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
  })

  it('creates the pull request after fresh main-process validation passes', async () => {
    await expect(
      createHostedReview('/repo', {
        provider: 'github',
        base: 'main',
        head: 'feature',
        title: 'Feature'
      })
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
        null,
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
      ['status', '--porcelain'],
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
        localGitExecOptions: { wslDistro: 'Ubuntu' }
      })
    )
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['auth', 'status', '--hostname', 'github.com'],
      { cwd: '/repo', wslDistro: 'Ubuntu' }
    )
    expect(createGitHubPullRequestMock).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ provider: 'github', head: 'feature' }),
      null,
      { localGitExecOptions: { wslDistro: 'Ubuntu' } }
    )
  })

  it('creates a GitLab merge request after fresh main-process validation passes', async () => {
    mockGitLabProvider()

    await expect(
      createHostedReview('/repo', {
        provider: 'gitlab',
        base: 'main',
        head: 'feature',
        title: 'Feature'
      })
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
      undefined
    )
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
  })

  it('creates an Azure DevOps pull request after fresh main-process validation passes', async () => {
    mockAzureDevOpsProvider()

    await expect(
      createHostedReview('/repo', {
        provider: 'azure-devops',
        base: 'main',
        head: 'feature',
        title: 'Feature'
      })
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
      undefined
    )
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
    expect(createGitLabMergeRequestMock).not.toHaveBeenCalled()
  })

  it('creates a Gitea pull request after fresh main-process validation passes', async () => {
    mockGiteaProvider()

    await expect(
      createHostedReview('/repo', {
        provider: 'gitea',
        base: 'main',
        head: 'feature',
        title: 'Feature'
      })
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
      undefined
    )
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
    expect(createGitLabMergeRequestMock).not.toHaveBeenCalled()
  })

  it('uses the SSH git provider for remote hosted-review preflight', async () => {
    const remoteGit = {
      getStatus: vi.fn(async () => ({ entries: [], conflictOperation: 'unknown' })),
      getUpstreamStatus: vi.fn(async () => ({
        hasUpstream: true,
        upstreamName: 'origin/feature',
        ahead: 0,
        behind: 0
      })),
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return { stdout: 'feature\n', stderr: '' }
        }
        if (args[0] === 'log' && args.includes('--pretty=%s')) {
          return { stdout: 'Feature title\n', stderr: '' }
        }
        if (args[0] === 'log') {
          return { stdout: '- Feature title\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      })
    }
    getSshGitProviderMock.mockReturnValue(remoteGit)

    await expect(
      createHostedReview(
        '/remote/repo',
        {
          provider: 'github',
          base: 'main',
          head: 'feature',
          title: 'Feature'
        },
        'ssh-1'
      )
    ).resolves.toEqual({
      ok: true,
      number: 12,
      url: 'https://github.com/acme/orca/pull/12'
    })

    expect(remoteGit.exec).toHaveBeenCalledWith(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      '/remote/repo'
    )
    expect(remoteGit.getStatus).toHaveBeenCalledWith('/remote/repo')
    expect(remoteGit.exec).not.toHaveBeenCalledWith(['status', '--porcelain'], '/remote/repo')
    expect(remoteGit.getUpstreamStatus).toHaveBeenCalledWith('/remote/repo')
    expect(remoteGit.exec).not.toHaveBeenCalledWith(
      ['rev-list', '--left-right', '--count', 'HEAD...@{u}'],
      '/remote/repo'
    )
    expect(getUpstreamStatusMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['auth', 'status', '--hostname', 'github.com'],
      {}
    )
    expect(createGitHubPullRequestMock).toHaveBeenCalledWith(
      '/remote/repo',
      {
        provider: 'github',
        base: 'main',
        head: 'feature',
        title: 'Feature'
      },
      'ssh-1'
    )
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
      createHostedReview('/repo', {
        provider: 'github',
        base: 'main',
        head: 'feature',
        title: 'Feature'
      })
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

describe('getHostedReviewCreationEligibility', () => {
  beforeEach(() => {
    resetMocks()

    mockGitHubProvider()
    getHostedReviewForBranchMock.mockResolvedValue(null)
    ghExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'Feature title\n', stderr: '' })
    isAzureDevOpsReviewCreationAuthenticatedMock.mockReturnValue(true)
    isGiteaReviewCreationAuthenticatedMock.mockReturnValue(true)
  })

  it('treats short remote base refs as the default branch name', async () => {
    await expect(
      getHostedReviewCreationEligibility({
        repoPath: '/repo',
        branch: 'main',
        base: 'origin/main',
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 0,
        behind: 0
      })
    ).resolves.toMatchObject({
      canCreate: false,
      blockedReason: 'default_branch',
      defaultBaseRef: 'origin/main'
    })
  })

  it('blocks dirty tracked GitHub branches before PR creation', async () => {
    await expect(
      getHostedReviewCreationEligibility({
        repoPath: '/repo',
        branch: 'feature/create-pr',
        base: 'main',
        hasUncommittedChanges: true,
        hasUpstream: true,
        ahead: 0,
        behind: 0
      })
    ).resolves.toMatchObject({
      provider: 'github',
      canCreate: false,
      blockedReason: 'dirty',
      nextAction: 'commit',
      head: 'feature/create-pr'
    })
  })

  it('keeps dirty feature branches eligible for PR preparation when review lookup fails', async () => {
    getHostedReviewForBranchMock.mockRejectedValueOnce(new Error('gh lookup failed'))

    await expect(
      getHostedReviewCreationEligibility({
        repoPath: '/repo',
        branch: 'feature/create-pr',
        base: 'main',
        hasUncommittedChanges: true,
        hasUpstream: false,
        ahead: 0,
        behind: 0
      })
    ).resolves.toMatchObject({
      provider: 'github',
      canCreate: false,
      blockedReason: 'dirty',
      nextAction: 'commit',
      head: 'feature/create-pr'
    })
  })

  it('enables creation for clean, in-sync, authenticated GitHub feature branches', async () => {
    await expect(
      getHostedReviewCreationEligibility({
        repoPath: '/repo',
        branch: 'refs/heads/feature/create-pr',
        base: 'origin/main',
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 0,
        behind: 0
      })
    ).resolves.toMatchObject({
      provider: 'github',
      canCreate: true,
      blockedReason: null,
      nextAction: null,
      defaultBaseRef: 'origin/main',
      head: 'feature/create-pr'
    })
  })

  it('resolves remote eligibility through SSH repo metadata without generating PR copy', async () => {
    const remoteGit = {
      exec: vi.fn(async () => ({ stdout: '', stderr: '' }))
    }
    getSshGitProviderMock.mockReturnValue(remoteGit)

    await expect(
      getHostedReviewCreationEligibility({
        repoPath: '/remote/repo',
        connectionId: 'ssh-1',
        branch: 'feature/create-pr',
        base: 'origin/main',
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 0,
        behind: 0
      })
    ).resolves.toMatchObject({
      provider: 'github',
      canCreate: true,
      head: 'feature/create-pr'
    })

    expect(getProjectSlugMock).toHaveBeenCalledWith('/remote/repo', 'ssh-1')
    expect(getRepoSlugMock).toHaveBeenCalledWith('/remote/repo', 'ssh-1')
    expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/remote/repo', connectionId: 'ssh-1' })
    )
    expect(remoteGit.exec).not.toHaveBeenCalled()
  })

  it('offers push as the next action for authenticated branches with local-only commits', async () => {
    await expect(
      getHostedReviewCreationEligibility({
        repoPath: '/repo',
        branch: 'feature/create-pr',
        base: 'main',
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 2,
        behind: 0
      })
    ).resolves.toMatchObject({
      canCreate: false,
      blockedReason: 'needs_push',
      nextAction: 'push'
    })
  })

  it('enables creation for clean, in-sync, authenticated GitLab feature branches', async () => {
    mockGitLabProvider()

    await expect(
      getHostedReviewCreationEligibility({
        repoPath: '/repo',
        branch: 'feature/gitlab',
        base: 'main',
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 0,
        behind: 0
      })
    ).resolves.toMatchObject({
      provider: 'gitlab',
      canCreate: true,
      blockedReason: null,
      nextAction: null,
      head: 'feature/gitlab'
    })
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['auth', 'status', '--hostname', 'gitlab.com'],
      { cwd: '/repo' }
    )
  })

  it('enables creation for clean, in-sync, token-configured Azure DevOps feature branches', async () => {
    mockAzureDevOpsProvider()

    await expect(
      getHostedReviewCreationEligibility({
        repoPath: '/repo',
        branch: 'feature/azure',
        base: 'main',
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 0,
        behind: 0
      })
    ).resolves.toMatchObject({
      provider: 'azure-devops',
      canCreate: true,
      blockedReason: null,
      nextAction: null,
      head: 'feature/azure'
    })
    expect(isAzureDevOpsReviewCreationAuthenticatedMock).toHaveBeenCalledOnce()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('enables creation for clean, in-sync, token-configured Gitea feature branches', async () => {
    mockGiteaProvider()

    await expect(
      getHostedReviewCreationEligibility({
        repoPath: '/repo',
        branch: 'feature/gitea',
        base: 'main',
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 0,
        behind: 0
      })
    ).resolves.toMatchObject({
      provider: 'gitea',
      canCreate: true,
      blockedReason: null,
      nextAction: null,
      head: 'feature/gitea'
    })
    expect(isGiteaReviewCreationAuthenticatedMock).toHaveBeenCalledOnce()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
