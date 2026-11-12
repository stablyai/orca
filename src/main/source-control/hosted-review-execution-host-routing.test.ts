import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'

/** Register two SSH targets to expose wrong-host fallback; reuse a name under runtime: to expose nested-namespace confusion. */

const {
  gitExecFileAsyncMock,
  ghExecFileAsyncMock,
  glabExecFileAsyncMock,
  getUpstreamStatusMock,
  getProjectSlugMock,
  getMergeRequestForBranchOrThrowMock,
  getRepoSlugMock,
  getPRForBranchOutcomeMock,
  getRepoUpstreamMock,
  getBitbucketRepoSlugMock,
  getBitbucketPullRequestForBranchOrThrowMock,
  getAzureDevOpsRepoSlugMock,
  getGiteaRepoSlugMock,
  createGitLabMergeRequestMock,
  createGitHubPullRequestMock,
  createBitbucketPullRequestMock,
  createAzureDevOpsPullRequestMock,
  createGiteaPullRequestMock,
  getEnterpriseGitHubRepoSlugMock,
  isBitbucketReviewCreationAuthenticatedMock,
  resolveDefaultBaseRefViaExecMock,
  probeAnyExactRefMock,
  assertRemoteUrlReadableMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  glabExecFileAsyncMock: vi.fn(),
  getUpstreamStatusMock: vi.fn(),
  getProjectSlugMock: vi.fn(),
  getMergeRequestForBranchOrThrowMock: vi.fn(),
  getRepoSlugMock: vi.fn(),
  getPRForBranchOutcomeMock: vi.fn(),
  getRepoUpstreamMock: vi.fn(),
  getBitbucketRepoSlugMock: vi.fn(),
  getBitbucketPullRequestForBranchOrThrowMock: vi.fn(),
  getAzureDevOpsRepoSlugMock: vi.fn(),
  getGiteaRepoSlugMock: vi.fn(),
  createGitLabMergeRequestMock: vi.fn(),
  createGitHubPullRequestMock: vi.fn(),
  createBitbucketPullRequestMock: vi.fn(),
  createAzureDevOpsPullRequestMock: vi.fn(),
  createGiteaPullRequestMock: vi.fn(),
  getEnterpriseGitHubRepoSlugMock: vi.fn(),
  isBitbucketReviewCreationAuthenticatedMock: vi.fn(),
  resolveDefaultBaseRefViaExecMock: vi.fn(),
  probeAnyExactRefMock: vi.fn(),
  assertRemoteUrlReadableMock: vi.fn()
}))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))

vi.mock('../github/execution/github-operation-slots', () => ({
  acquire: vi.fn(async () => {}),
  release: vi.fn()
}))

vi.mock('../gitlab/requests/glab-request-admission', () => ({
  acquire: vi.fn(async () => {}),
  release: vi.fn()
}))

vi.mock('../git/command-runner/hosted-cli/glab-exec-file', () => ({
  glabExecFileAsync: glabExecFileAsyncMock
}))

vi.mock('../gitlab/projects/gitlab-project-ref-resolution', () => ({
  glabRepoExecOptions: vi.fn(() => ({}))
}))

vi.mock('../git/command-runner/git-environment/git-process-env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitOptionalLocksDisabledEnv: vi.fn(() => ({}))
}))

vi.mock('../git/source-control/upstream', () => ({ getUpstreamStatus: getUpstreamStatusMock }))

vi.mock('../../shared/git/refs/git-default-base-ref', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveDefaultBaseRefViaExec: resolveDefaultBaseRefViaExecMock
}))

vi.mock('../git/refs/resolution/exact-ref-probe', () => ({
  probeAnyExactRef: probeAnyExactRefMock
}))

vi.mock('../git/worktrees/content-paths/worktree-symlink-detection', () => ({
  findExistingWorktreeSymlinkPaths: vi.fn(async () => [])
}))

vi.mock('../git/remotes/remote-url-probe', () => ({
  assertRemoteUrlReadable: assertRemoteUrlReadableMock,
  withSharedRemoteUrlReads: <T>(work: () => Promise<T>) => work()
}))

vi.mock('../gitlab/merge-requests/merge-request-lookup', () => ({
  getProjectSlug: getProjectSlugMock,
  getMergeRequest: vi.fn(async () => null),
  getMergeRequestForBranchOrThrow: getMergeRequestForBranchOrThrowMock
}))

vi.mock('../gitlab/merge-requests/merge-request-creation', () => ({
  createGitLabMergeRequest: createGitLabMergeRequestMock
}))

vi.mock('../github/client/fetch/repo-slug-upstream', () => ({
  getRepoSlug: getRepoSlugMock,
  getRepoUpstream: getRepoUpstreamMock
}))

vi.mock('../github/client/lookup/pr-for-branch-outcome', () => ({
  getPRForBranchOutcome: getPRForBranchOutcomeMock
}))

vi.mock('../github/client/lookup/pr-lookup-rate-limit', () => ({
  getGitHubPRLookupRateLimitBlock: vi.fn(async () => null)
}))

vi.mock('../github/client/create/create-github-pull-request', () => ({
  createGitHubPullRequest: createGitHubPullRequestMock
}))

vi.mock('../github/repositories/github-enterprise-repository', () => ({
  getEnterpriseGitHubRepoSlug: getEnterpriseGitHubRepoSlugMock
}))

vi.mock('../bitbucket/client', () => ({
  getBitbucketRepoSlug: getBitbucketRepoSlugMock,
  getBitbucketPullRequest: vi.fn(async () => null),
  getBitbucketPullRequestForBranchOrThrow: getBitbucketPullRequestForBranchOrThrowMock
}))

vi.mock('../bitbucket/pull-request-creation', () => ({
  createBitbucketPullRequest: createBitbucketPullRequestMock,
  isBitbucketReviewCreationAuthenticated: isBitbucketReviewCreationAuthenticatedMock
}))

vi.mock('../azure-devops/client', () => ({
  getAzureDevOpsRepoSlug: getAzureDevOpsRepoSlugMock,
  getAzureDevOpsPullRequest: vi.fn(async () => null),
  getAzureDevOpsPullRequestForBranchOrThrow: vi.fn(async () => null)
}))

vi.mock('../azure-devops/pull-request-creation', () => ({
  createAzureDevOpsPullRequest: createAzureDevOpsPullRequestMock,
  isAzureDevOpsReviewCreationAuthenticated: vi.fn(async () => true)
}))

vi.mock('../gitea/client', () => ({
  getGiteaRepoSlug: getGiteaRepoSlugMock,
  getGiteaPullRequest: vi.fn(async () => null),
  getGiteaPullRequestForBranchOrThrow: vi.fn(async () => null)
}))

vi.mock('../gitea/pull-request-creation', () => ({
  createGiteaPullRequest: createGiteaPullRequestMock,
  isGiteaReviewCreationAuthenticated: vi.fn(async () => true)
}))

import { __resetHostedReviewBranchCacheForTests } from './hosted-review-branch-cache'
import '../workspaces/execution-host/repo-execution-host'
import './hosted-review-execution-host'
import { RuntimeHostedReviewCommands } from '../runtime/integrations/reviews/runtime-hosted-review-commands'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'

const REPO_PATH = '/remote/workspace/repo'

type SshProviderStub = {
  exec: ReturnType<typeof vi.fn>
  getStatus: ReturnType<typeof vi.fn>
  getUpstreamStatus: ReturnType<typeof vi.fn>
}

const sshProviders = new Map<string, SshProviderStub>()

function makeSshProvider(): SshProviderStub {
  return {
    exec: vi.fn(async () => ({ stdout: 'feature\n', stderr: '' })),
    getStatus: vi.fn(async () => ({ entries: [] })),
    getUpstreamStatus: vi.fn(async () => ({ hasUpstream: true, ahead: 0, behind: 0 }))
  }
}

function makeRepo(overrides: Partial<Repo>): Repo {
  return {
    id: 'repo-1',
    path: REPO_PATH,
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git',
    ...overrides
  } as Repo
}

function makeCommands(repo: Repo): RuntimeHostedReviewCommands {
  return new RuntimeHostedReviewCommands({
    resolveRepo: async () => repo,
    resolveTarget: async () => ({ repo, repoPath: repo.path }),
    getExecutionOptions: () => undefined,
    recordCreated: () => {}
  })
}

function sshTargetThatRanGit(): string | null {
  for (const [id, provider] of sshProviders) {
    if (provider.exec.mock.calls.length > 0 || provider.getStatus.mock.calls.length > 0) {
      return id
    }
  }
  return null
}

const CREATE_INPUT = {
  base: 'main',
  head: 'feature',
  title: 'Add a thing',
  body: '',
  draft: false
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetHostedReviewBranchCacheForTests()
  sshProviders.clear()
  sshProviders.set('ssh-a', makeSshProvider())
  sshProviders.set('ssh-b', makeSshProvider())

  gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => ({
    stdout: argv[0] === 'status' ? '' : 'feature\n',
    stderr: ''
  }))
  ghExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
  glabExecFileAsyncMock.mockResolvedValue({ stdout: '{}', stderr: '' })
  getUpstreamStatusMock.mockResolvedValue({ hasUpstream: true, ahead: 0, behind: 0 })
  resolveDefaultBaseRefViaExecMock.mockImplementation(
    async (run: (argv: string[]) => Promise<{ stdout: string }>) => {
      await run(['rev-parse', '--abbrev-ref', 'origin/HEAD'])
      return 'main'
    }
  )
  probeAnyExactRefMock.mockResolvedValue({ found: true, unknown: false })
  assertRemoteUrlReadableMock.mockResolvedValue(undefined)

  getProjectSlugMock.mockResolvedValue(null)
  getRepoSlugMock.mockResolvedValue(null)
  getRepoUpstreamMock.mockResolvedValue(null)
  getBitbucketRepoSlugMock.mockResolvedValue(null)
  getAzureDevOpsRepoSlugMock.mockResolvedValue(null)
  getGiteaRepoSlugMock.mockResolvedValue(null)
  getPRForBranchOutcomeMock.mockResolvedValue({ kind: 'not_found' })
  getMergeRequestForBranchOrThrowMock.mockResolvedValue(null)
  getBitbucketPullRequestForBranchOrThrowMock.mockResolvedValue(null)
  getEnterpriseGitHubRepoSlugMock.mockResolvedValue({ host: 'github.com', owner: 'a', repo: 'b' })
  isBitbucketReviewCreationAuthenticatedMock.mockResolvedValue(true)
  createGitHubPullRequestMock.mockResolvedValue({ ok: true, number: 7, url: 'https://pr/7' })
  createGitLabMergeRequestMock.mockResolvedValue({ ok: true, number: 7, url: 'https://mr/7' })
  createBitbucketPullRequestMock.mockResolvedValue({ ok: true, number: 7, url: 'https://pr/7' })
  createAzureDevOpsPullRequestMock.mockResolvedValue({ ok: true, number: 7, url: 'https://pr/7' })
  createGiteaPullRequestMock.mockResolvedValue({ ok: true, number: 7, url: 'https://pr/7' })
})

describe('hosted-review creation routes on the resolved execution host', () => {
  it('refuses GitLab preflight on an executionHostId-only SSH host without running git here', async () => {
    getProjectSlugMock.mockResolvedValue({ host: 'gitlab.com', path: 'acme/widgets' })
    const commands = makeCommands(makeRepo({ executionHostId: 'ssh:ssh-a' }))

    await expect(
      commands.createHostedReview({ repoSelector: 'repo-1', provider: 'gitlab', ...CREATE_INPUT })
    ).rejects.toThrow(SshHostNotServedError)

    expect(sshTargetThatRanGit()).toBeNull()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(createGitLabMergeRequestMock).not.toHaveBeenCalled()
  })
})
