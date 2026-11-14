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

vi.mock('../github/client/create/create-github-pull-request', () => ({
  createGitHubPullRequest: createGitHubPullRequestMock
}))

vi.mock('../github/client/fetch/repo-slug-upstream', () => ({
  getRepoSlug: getRepoSlugMock
}))

vi.mock('../github/client/lookup/get-pr-for-branch', () => ({
  getPRForBranch: vi.fn()
}))

vi.mock('../github/repositories/github-enterprise-repository', () => ({
  getEnterpriseGitHubRepoSlug: getEnterpriseGitHubRepoSlugMock
}))

vi.mock('../gitlab/merge-requests/merge-request-lookup', () => ({
  getProjectSlug: getProjectSlugMock,
  getMergeRequestForBranch: vi.fn(),
  getMergeRequest: vi.fn()
}))

vi.mock('../gitlab/merge-requests/merge-request-creation', () => ({
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

vi.mock('../github/execution/github-operation-slots', () => ({
  acquire: vi.fn(),
  release: vi.fn()
}))

vi.mock('../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../gitlab/requests/glab-request-admission', () => ({
  acquire: vi.fn(),
  release: vi.fn()
}))

vi.mock('../git/command-runner/hosted-cli/glab-exec-file', () => ({
  glabExecFileAsync: glabExecFileAsyncMock
}))

vi.mock('../gitlab/projects/gitlab-project-ref-resolution', () => ({
  glabRepoExecOptions: (repoPath: string, connectionId?: string | null) =>
    connectionId ? {} : { cwd: repoPath }
}))

vi.mock('../git/source-control/upstream/upstream', () => ({
  getUpstreamStatus: getUpstreamStatusMock
}))

vi.mock('./hosted-review', () => ({
  getHostedReviewForBranch: getHostedReviewForBranchMock
}))

import { createHostedReview, getHostedReviewCreationEligibility } from './hosted-review-creation'
import { baseRefExistsOnRemote } from './hosted-review-creation-git-state'

import { _resetOriginGitHubApiRepositoryCache } from '../github/repositories/github-api-repository-remote-probe'

const LOCAL_REPO_ARGS = { executionHostId: 'local' as const, repoPath: '/repo' }

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

describe('getHostedReviewCreationEligibility', () => {
  beforeEach(() => {
    resetMocks()

    mockGitHubProvider()
    getHostedReviewForBranchMock.mockResolvedValue(null)
    ghExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'Feature title\n', stderr: '' })
  })

  it('keeps a nested bare branch discoverable on an unconfigured stale remote', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'fork\n', stderr: '' }
      }
      if (args[0] === 'show-ref' && args.some((arg) => arg.startsWith('refs/remotes/'))) {
        throw Object.assign(new Error('missing ref'), { code: 1 })
      }
      if (args[0] === 'show-ref') {
        expect(args).toEqual(['show-ref', '--', 'feature/fix'])
        return { stdout: 'abc123 refs/remotes/orphan/feature/fix\n' }
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    await expect(baseRefExistsOnRemote('feature/fix', '/repo', 'local')).resolves.toBe(true)
  })

  it('does not treat a nested branch ending in HEAD as the bare remote HEAD', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'fork\n', stderr: '' }
      }
      if (args[0] === 'show-ref' && args.some((arg) => arg.startsWith('refs/remotes/'))) {
        throw Object.assign(new Error('missing ref'), { code: 1 })
      }
      if (args[0] === 'show-ref') {
        expect(args).toEqual(['show-ref', '--', 'HEAD'])
        return { stdout: 'abc123 refs/remotes/fork/feature/HEAD\n', stderr: '' }
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    await expect(baseRefExistsOnRemote('HEAD', '/repo', 'local')).resolves.toBe(false)
  })

  it('refuses to create when the existing-review lookup is unavailable (finding 5)', async () => {
    getHostedReviewForBranchMock.mockRejectedValue(new Error('glab: connection refused'))
    getUpstreamStatusMock.mockResolvedValue({ hasUpstream: true, ahead: 0, behind: 0 })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        return { stdout: 'feature/x\n', stderr: '' }
      }
      if (args[0] === 'status') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'for-each-ref' && args.includes('--format=%(refname)%00%(symref)')) {
        return { stdout: 'refs/remotes/origin/HEAD\0refs/remotes/origin/main\n', stderr: '' }
      }
      return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
    })

    const result = await createHostedReview(
      '/repo',
      {
        provider: 'github',
        base: 'main',
        head: 'feature/x',
        title: 'Add feature'
      },
      'local'
    )

    expect(result).toMatchObject({ ok: false, code: 'validation' })
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
  })

  const stackedArgs = (
    overrides: Partial<Parameters<typeof getHostedReviewCreationEligibility>[0]> = {}
  ): Parameters<typeof getHostedReviewCreationEligibility>[0] => ({
    ...LOCAL_REPO_ARGS,
    branch: 'feature/stacked',
    base: 'stacked-parent',
    hasUncommittedChanges: false,
    hasUpstream: true,
    ahead: 0,
    behind: 0,
    ...overrides
  })

  const mockRefs = (opts: { defaultRef?: string }): void => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'for-each-ref' && args.includes('--format=%(refname)%00%(symref)')) {
        return {
          stdout: opts.defaultRef ? `refs/remotes/origin/HEAD\0${opts.defaultRef}\n` : '',
          stderr: ''
        }
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        throw Object.assign(new Error('missing ref'), { code: 1 })
      }
      return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
    })
  }

  it('falls back to the repo default when a stacked parent base is local-only', async () => {
    mockRefs({ defaultRef: 'refs/remotes/origin/main' })
    await expect(getHostedReviewCreationEligibility(stackedArgs())).resolves.toMatchObject({
      canCreate: true,
      blockedReason: null,
      defaultBaseRef: 'origin/main'
    })
  })
})
