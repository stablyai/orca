import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  glabExecFileAsyncMock,
  ghExecFileAsyncMock,
  getAzureDevOpsRepoSlugMock,
  getBitbucketRepoSlugMock,
  getGiteaRepoSlugMock,
  getHostedReviewForBranchMock,
  getRepoSlugMock,
  getSshGitProviderMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  glabExecFileAsyncMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  getAzureDevOpsRepoSlugMock: vi.fn(),
  getBitbucketRepoSlugMock: vi.fn(),
  getGiteaRepoSlugMock: vi.fn(),
  getHostedReviewForBranchMock: vi.fn(),
  getRepoSlugMock: vi.fn(),
  getSshGitProviderMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  glabExecFileAsync: glabExecFileAsyncMock,
  ghExecFileAsync: ghExecFileAsyncMock,
  extractExecError: vi.fn()
}))

vi.mock('../github/client', () => ({
  createGitHubPullRequest: vi.fn(),
  getRepoSlug: getRepoSlugMock,
  getPRForBranch: vi.fn()
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

vi.mock('../gitea/client', () => ({
  getGiteaRepoSlug: getGiteaRepoSlugMock,
  getGiteaPullRequestForBranch: vi.fn(),
  getGiteaPullRequest: vi.fn()
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

vi.mock('./hosted-review', () => ({
  getHostedReviewForBranch: getHostedReviewForBranchMock
}))

import { _resetKnownHostsCache, _resetProjectRefCache } from '../gitlab/gl-utils'
import { getHostedReviewCreationEligibility } from './hosted-review-creation'

function resetMocks(): void {
  for (const mock of [
    gitExecFileAsyncMock,
    glabExecFileAsyncMock,
    ghExecFileAsyncMock,
    getAzureDevOpsRepoSlugMock,
    getBitbucketRepoSlugMock,
    getGiteaRepoSlugMock,
    getHostedReviewForBranchMock,
    getRepoSlugMock,
    getSshGitProviderMock
  ]) {
    mock.mockReset()
  }
  _resetKnownHostsCache()
  _resetProjectRefCache()
}

function mockNonGitLabProviders(): void {
  getRepoSlugMock.mockResolvedValue(null)
  getBitbucketRepoSlugMock.mockResolvedValue(null)
  getAzureDevOpsRepoSlugMock.mockResolvedValue(null)
  getGiteaRepoSlugMock.mockResolvedValue(null)
}

describe('GitLab self-hosted hosted review creation eligibility', () => {
  beforeEach(() => {
    resetMocks()
    mockNonGitLabProviders()
    getHostedReviewForBranchMock.mockResolvedValue(null)
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'git@gitlab.internal:team/orca.git\n',
      stderr: ''
    })
  })

  it('enables MR creation when glab recognizes the self-hosted origin host', async () => {
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'auth' && args[1] === 'status' && args.includes('--hostname')) {
        return {
          stdout: `gitlab.internal
  ✓ Logged in as user
`,
          stderr: ''
        }
      }
      if (args[0] === 'auth' && args[1] === 'status') {
        return {
          stdout: `gitlab.com
  ✓ Logged in to gitlab.com as user
`,
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      getHostedReviewCreationEligibility({
        repoPath: '/repo',
        branch: 'feature/self-hosted-mr',
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
      head: 'feature/self-hosted-mr'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo'
    })
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['auth', 'status', '--hostname', 'gitlab.internal'],
      { cwd: '/repo' }
    )
  })

  it('classifies known-but-unauthenticated self-hosted GitLab as auth_required', async () => {
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'auth' && args[1] === 'status' && args.includes('--hostname')) {
        const error = new Error('invalid token provided') as Error & {
          stdout: string
          stderr: string
        }
        error.stdout = `gitlab.internal
  ! Invalid token provided
`
        error.stderr = ''
        throw error
      }
      if (args[0] === 'auth' && args[1] === 'status') {
        return {
          stdout: `gitlab.com
  ✓ Logged in to gitlab.com as user
gitlab.internal
  ! Invalid token provided
`,
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await getHostedReviewCreationEligibility({
      repoPath: '/repo',
      branch: 'feature/self-hosted-mr',
      base: 'main',
      hasUncommittedChanges: false,
      hasUpstream: true,
      ahead: 0,
      behind: 0
    })
    expect(result).toMatchObject({
      provider: 'gitlab',
      canCreate: false,
      blockedReason: 'auth_required',
      nextAction: 'authenticate'
    })
  })
})
