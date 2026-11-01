import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  glabExecFileAsyncMock,
  ghExecFileAsyncMock,
  getAzureDevOpsRepoSlugMock,
  getBitbucketRepoSlugMock,
  getGiteaRepoSlugMock,
  getHostedReviewForBranchMock,
  getRepoSlugMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  glabExecFileAsyncMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  getAzureDevOpsRepoSlugMock: vi.fn(),
  getBitbucketRepoSlugMock: vi.fn(),
  getGiteaRepoSlugMock: vi.fn(),
  getHostedReviewForBranchMock: vi.fn(),
  getRepoSlugMock: vi.fn()
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

vi.mock('./hosted-review', () => ({
  getHostedReviewForBranch: getHostedReviewForBranchMock
}))

import { _resetKnownHostsCache, _resetProjectRefCache } from '../gitlab/gl-utils'
import { diagnoseAuth } from '../gitlab/client'
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
    getRepoSlugMock
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

  it('recovers provider detection after auth diagnostics discover a rejected host', async () => {
    let selfHostedAuthenticated = false
    getGiteaRepoSlugMock.mockResolvedValue({
      host: 'gitlab.example.com',
      owner: 'team',
      repo: 'orca',
      apiBaseUrl: 'https://gitlab.example.com/api/v1',
      webBaseUrl: 'https://gitlab.example.com'
    })
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://gitlab.example.com/team/orca.git\n',
      stderr: ''
    })
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('--hostname')) {
        if (!selfHostedAuthenticated) {
          throw new Error('authentication required for gitlab.example.com')
        }
        return {
          stdout: '✓ Logged in to gitlab.example.com as user\n',
          stderr: ''
        }
      }
      return selfHostedAuthenticated
        ? {
            stdout: '✓ Logged in to gitlab.example.com as user\n',
            stderr: ''
          }
        : {
            stdout: '✓ Logged in to gitlab.com as user\n',
            stderr: ''
          }
    })

    const eligibilityInput = {
      executionHostId: 'local' as const,
      repoPath: '/repo',
      branch: 'feature/self-hosted-mr',
      base: 'main',
      hasUncommittedChanges: false,
      hasUpstream: true,
      ahead: 0,
      behind: 0
    }
    await expect(getHostedReviewCreationEligibility(eligibilityInput)).resolves.toMatchObject({
      provider: 'gitea',
      blockedReason: 'auth_required'
    })

    selfHostedAuthenticated = true
    await expect(diagnoseAuth()).resolves.toMatchObject({
      authenticated: true,
      hosts: ['gitlab.example.com']
    })
    await expect(getHostedReviewCreationEligibility(eligibilityInput)).resolves.toMatchObject({
      provider: 'gitlab',
      canCreate: true,
      blockedReason: null
    })
  })
})
