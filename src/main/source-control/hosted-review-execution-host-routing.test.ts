import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'

/**
 * Routing cases for the hosted-review contract.
 *
 * Two SSH targets are registered at once in every case on purpose: routing that answers with
 * "some connected host" rather than *this row's* host only shows up once a second one exists,
 * and the `runtime:` cases reuse one of those names so a nested target cannot be told apart
 * from a client-dialable one by its spelling.
 */

const {
  getSshGitProviderMock,
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
  getSshGitProviderMock: vi.fn(),
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

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'SSH git provider unavailable'
}))

vi.mock('../github/gh-utils', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  ghExecFileAsync: ghExecFileAsyncMock,
  acquire: vi.fn(async () => {}),
  release: vi.fn()
}))

vi.mock('../gitlab/gl-utils', () => ({
  acquire: vi.fn(async () => {}),
  release: vi.fn(),
  glabExecFileAsync: glabExecFileAsyncMock,
  glabRepoExecOptions: vi.fn(() => ({}))
}))

vi.mock('../git/runner', () => ({
  gitOptionalLocksDisabledEnv: vi.fn(() => ({}))
}))

vi.mock('../git/upstream', () => ({ getUpstreamStatus: getUpstreamStatusMock }))

vi.mock('../git/repo', () => ({
  resolveDefaultBaseRefViaExec: resolveDefaultBaseRefViaExecMock
}))

vi.mock('../git/exact-ref-probe', () => ({
  probeAnyExactRef: probeAnyExactRefMock,
  isShowRefNoMatchError: vi.fn(() => false)
}))

vi.mock('../git/worktree-symlink-detection', () => ({
  findExistingWorktreeSymlinkPaths: vi.fn(async () => [])
}))

vi.mock('../git/remote-url-probe', () => ({
  assertRemoteUrlReadable: assertRemoteUrlReadableMock
}))

vi.mock('../gitlab/client', () => ({
  getProjectSlug: getProjectSlugMock,
  getMergeRequest: vi.fn(async () => null),
  getMergeRequestForBranchOrThrow: getMergeRequestForBranchOrThrowMock
}))

vi.mock('../gitlab/merge-request-creation', () => ({
  createGitLabMergeRequest: createGitLabMergeRequestMock
}))

vi.mock('../github/client', () => ({
  getRepoSlug: getRepoSlugMock,
  getRepoUpstream: getRepoUpstreamMock,
  getPRForBranchOutcome: getPRForBranchOutcomeMock,
  getGitHubPRLookupRateLimitBlock: vi.fn(async () => null),
  createGitHubPullRequest: createGitHubPullRequestMock
}))

vi.mock('../github/github-enterprise-repository', () => ({
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
import {
  getRepoHostedReviewExecutionHostId,
  hostedReviewSshConnectionId
} from './hosted-review-execution-host'
import { RuntimeHostedReviewCommands } from '../runtime/runtime-hosted-review-commands'

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

/** Which SSH target the git-state layer actually ran the preflight on, or null for local. */
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
  getSshGitProviderMock.mockImplementation((id: string) => sshProviders.get(id) ?? null)

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

  // No forge claims the remote unless a case says so; each test opts its provider in.
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

describe('hosted-review lookups route on the resolved execution host', () => {
  it('reads a GitHub review on the SSH host a row names only in executionHostId', async () => {
    getRepoSlugMock.mockResolvedValue({ host: 'github.com', owner: 'a', repo: 'b' })
    const commands = makeCommands(makeRepo({ executionHostId: 'ssh:ssh-a' }))

    await commands.getHostedReviewForBranch({ repoSelector: 'repo-1', branch: 'feature' })

    expect(getRepoSlugMock).toHaveBeenCalledWith(REPO_PATH, 'ssh-a')
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith(
      REPO_PATH,
      'feature',
      null,
      'ssh-a',
      null,
      expect.anything()
    )
  })

  it('reads a GitLab review on the executionHostId host when connectionId names a different one', async () => {
    getProjectSlugMock.mockResolvedValue({ host: 'gitlab.com', path: 'acme/widgets' })
    const commands = makeCommands(makeRepo({ connectionId: 'ssh-b', executionHostId: 'ssh:ssh-a' }))

    await commands.getHostedReviewForBranch({ repoSelector: 'repo-1', branch: 'feature' })

    expect(getProjectSlugMock).toHaveBeenCalledWith(REPO_PATH, 'ssh-a')
    expect(getMergeRequestForBranchOrThrowMock).toHaveBeenCalledWith(
      REPO_PATH,
      'feature',
      null,
      'ssh-a'
    )
    expect(getProjectSlugMock).not.toHaveBeenCalledWith(REPO_PATH, 'ssh-b')
  })

  it('does not dial this client for a runtime row whose nested target shares a local name', async () => {
    getBitbucketRepoSlugMock.mockResolvedValue({ workspace: 'acme', repo: 'widgets' })
    const commands = makeCommands(
      makeRepo({ connectionId: 'ssh-b', executionHostId: 'runtime:env-1' })
    )

    await commands.getHostedReviewForBranch({ repoSelector: 'repo-1', branch: 'feature' })

    expect(getBitbucketRepoSlugMock).toHaveBeenCalledWith(REPO_PATH, null)
    expect(getSshGitProviderMock).not.toHaveBeenCalledWith('ssh-b')
  })

  it('keeps a runtime row with no nested target on this process (self-addressed stamp)', async () => {
    getGiteaRepoSlugMock.mockResolvedValue({ host: 'gitea.example', owner: 'a', repo: 'b' })
    const commands = makeCommands(makeRepo({ executionHostId: 'runtime:env-1' }))

    await commands.getHostedReviewForBranch({ repoSelector: 'repo-1', branch: 'feature' })

    expect(getGiteaRepoSlugMock).toHaveBeenCalledWith(REPO_PATH, null)
  })

  it('keeps a legacy connectionId-only SSH row on its target', async () => {
    getRepoSlugMock.mockResolvedValue({ host: 'github.com', owner: 'a', repo: 'b' })
    const commands = makeCommands(makeRepo({ connectionId: 'ssh-b' }))

    await commands.getHostedReviewForBranch({ repoSelector: 'repo-1', branch: 'feature' })

    expect(getRepoSlugMock).toHaveBeenCalledWith(REPO_PATH, 'ssh-b')
  })

  it('does not share a cached answer between two rows at one path on different hosts', async () => {
    getRepoSlugMock.mockResolvedValue({ host: 'github.com', owner: 'a', repo: 'b' })
    await makeCommands(makeRepo({ executionHostId: 'ssh:ssh-a' })).getHostedReviewForBranch({
      repoSelector: 'repo-1',
      branch: 'feature'
    })
    getPRForBranchOutcomeMock.mockClear()

    await makeCommands(
      makeRepo({ id: 'repo-2', executionHostId: 'local' })
    ).getHostedReviewForBranch({ repoSelector: 'repo-2', branch: 'feature' })

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith(
      REPO_PATH,
      'feature',
      null,
      null,
      null,
      expect.anything()
    )
  })
})

describe('hosted-review creation routes on the resolved execution host', () => {
  it('runs the GitLab preflight and create on the executionHostId-only SSH host', async () => {
    getProjectSlugMock.mockResolvedValue({ host: 'gitlab.com', path: 'acme/widgets' })
    const commands = makeCommands(makeRepo({ executionHostId: 'ssh:ssh-a' }))

    const result = await commands.createHostedReview({
      repoSelector: 'repo-1',
      provider: 'gitlab',
      ...CREATE_INPUT
    })

    expect(result.ok).toBe(true)
    expect(sshTargetThatRanGit()).toBe('ssh-a')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(createGitLabMergeRequestMock).toHaveBeenCalledWith(
      REPO_PATH,
      expect.objectContaining({ provider: 'gitlab' }),
      'ssh:ssh-a'
    )
  })

  it('runs the GitHub preflight on the executionHostId host, not the connectionId one', async () => {
    getRepoSlugMock.mockResolvedValue({ host: 'github.com', owner: 'a', repo: 'b' })
    const commands = makeCommands(makeRepo({ connectionId: 'ssh-b', executionHostId: 'ssh:ssh-a' }))

    const result = await commands.createHostedReview({
      repoSelector: 'repo-1',
      provider: 'github',
      ...CREATE_INPUT
    })

    expect(result.ok).toBe(true)
    expect(sshTargetThatRanGit()).toBe('ssh-a')
    expect(createGitHubPullRequestMock).toHaveBeenCalledWith(
      REPO_PATH,
      expect.objectContaining({ provider: 'github' }),
      'ssh:ssh-a'
    )
  })

  it('creates a Bitbucket review locally for a runtime row rather than dialing its nested target', async () => {
    getBitbucketRepoSlugMock.mockResolvedValue({ workspace: 'acme', repo: 'widgets' })
    const commands = makeCommands(
      makeRepo({ connectionId: 'ssh-b', executionHostId: 'runtime:env-1' })
    )

    const result = await commands.createHostedReview({
      repoSelector: 'repo-1',
      provider: 'bitbucket',
      ...CREATE_INPUT
    })

    expect(result.ok).toBe(true)
    expect(sshTargetThatRanGit()).toBeNull()
    expect(createBitbucketPullRequestMock).toHaveBeenCalledWith(
      REPO_PATH,
      expect.objectContaining({ provider: 'bitbucket' }),
      'local'
    )
  })

  it('reports creation eligibility from the executionHostId-only SSH host', async () => {
    getAzureDevOpsRepoSlugMock.mockResolvedValue({ organization: 'acme', project: 'p', repo: 'r' })
    const commands = makeCommands(makeRepo({ executionHostId: 'ssh:ssh-a' }))

    await commands.getHostedReviewCreationEligibility({
      repoSelector: 'repo-1',
      branch: 'feature',
      base: 'main',
      hasUpstream: true,
      ahead: 0,
      behind: 0
    })

    expect(getAzureDevOpsRepoSlugMock).toHaveBeenCalledWith(REPO_PATH, 'ssh-a')
    expect(sshTargetThatRanGit()).toBe('ssh-a')
  })

  it('resolves the GitHub slug for a repo listing on the row it is asked about', async () => {
    getRepoSlugMock.mockResolvedValue({ host: 'github.com', owner: 'a', repo: 'b' })
    const commands = makeCommands(makeRepo({ executionHostId: 'ssh:ssh-a' }))

    await commands.getRepoSlug('repo-1')

    expect(getRepoSlugMock).toHaveBeenCalledWith(REPO_PATH, 'ssh-a')
  })
})

describe('hosted-review host resolution', () => {
  it('refuses to dial a runtime host from this process', () => {
    expect(() => hostedReviewSshConnectionId('runtime:env-1')).toThrow(
      'is not dispatched by this process'
    )
  })

  it('answers with the SSH target for both spellings and local otherwise', () => {
    expect(hostedReviewSshConnectionId('ssh:ssh-a')).toBe('ssh-a')
    expect(hostedReviewSshConnectionId('local')).toBeNull()
    expect(getRepoHostedReviewExecutionHostId({ executionHostId: 'ssh:ssh-a' })).toBe('ssh:ssh-a')
    expect(getRepoHostedReviewExecutionHostId({ connectionId: 'ssh-b' })).toBe('ssh:ssh-b')
  })

  it('reads a runtime stamp on a row in this store as self-addressing, not a second machine', () => {
    // The registration controller only adopts `runtime:` onto a row with no connectionId, so the
    // checkout is here; a nested target belongs to that server's namespace and is never dialed.
    expect(getRepoHostedReviewExecutionHostId({ executionHostId: 'runtime:env-1' })).toBe('local')
    expect(
      getRepoHostedReviewExecutionHostId({
        executionHostId: 'runtime:env-1',
        connectionId: 'ssh-b'
      })
    ).toBe('local')
  })
})
