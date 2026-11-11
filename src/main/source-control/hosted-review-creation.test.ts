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

vi.mock('../git/source-control/upstream', () => ({
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
      error: 'Create PR failed: push this branch before creating a pull request.',
      reason: 'needs_push'
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
      error: 'Create PR failed: switch back to the selected branch before creating a pull request.',
      reason: 'branch_changed'
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
        'Create PR failed: the base branch "stacked-parent" hasn\'t been pushed to the remote. Choose a pushed base or push it first.',
      reason: 'base_not_on_remote',
      base: 'stacked-parent'
    })
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
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
      reason: 'existing_review',
      existingReview: {
        number: 31,
        url: 'https://github.com/acme/orca/pull/31'
      }
    })
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
  })
})
