import type * as GithubRepositoryIdentityModule from '../../repositories/github-repository-identity'
import type * as GithubApiRepositoryModule from '../../repositories/github-api-repository'
import type * as GithubApiRepositoryRemoteProbeModule from '../../repositories/github-api-repository-remote-probe'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Keep legacy REST request/failure coverage; API-boundary suites exercise the GraphQL path.
vi.mock('./work-item-search-page', () => ({ usesGraphqlWorkItemSearch: () => false }))

const {
  execFileAsyncMock,
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getIssueOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  resolveIssueSourceMock,
  gitExecFileAsyncMock,
  rateLimitGuardMock,
  noteRateLimitSpendMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  getOwnerRepoForRemoteMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  rateLimitGuardMock: vi.fn((_bucket?: unknown) => ({ blocked: false })),
  noteRateLimitSpendMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('../../execution/github-legacy-command', () => ({
  execFileAsync: execFileAsyncMock
}))

vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))

vi.mock('../../repositories/github-repository-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubRepositoryIdentityModule>()),
  githubRepoContext: (
    repoPath: string,
    connectionId?: string | null,
    localGitOptions: { wslDistro?: string } = {}
  ) => ({
    repoPath,
    connectionId: connectionId ?? null,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
  }),
  ghRepoExecOptions: (context: {
    repoPath: string
    connectionId?: string | null
    wslDistro?: string
  }) =>
    context.connectionId
      ? {}
      : { cwd: context.repoPath, ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}) },
  getOwnerRepoForRemote: getOwnerRepoForRemoteMock,
  _resetOwnerRepoCache: vi.fn()
}))

vi.mock('../../repositories/github-owner-repo-selection', () => ({
  getOwnerRepo: getOwnerRepoMock,
  resolveIssueSource: resolveIssueSourceMock
}))

vi.mock('../../execution/github-operation-slots', () => ({
  acquire: acquireMock,
  release: releaseMock
}))

vi.mock('../../api/gh-error-classification', () => ({
  classifyGhError: (stderr: string) => ({ type: 'unknown', message: stderr }),
  classifyListIssuesError: (stderr: string) => ({ type: 'unknown', message: stderr }),
  classifyListPrsError: (stderr: string) => ({ type: 'unknown', message: stderr })
}))

vi.mock('../../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../../api/rate-limit', () => ({
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock,
  getRateLimit: vi.fn(async () => ({ ok: false, error: 'not probed in tests' })),
  repositoryRateLimitGuard: vi.fn((_repo: unknown, bucket: string) => rateLimitGuardMock(bucket)),
  noteRepositoryRateLimitSpend: vi.fn((_repo: unknown, bucket: string, cost?: number) =>
    noteRateLimitSpendMock(bucket, cost)
  ),
  spendsSharedGitHubComQuota: () => true
}))

vi.mock('../../repositories/github-api-repository', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof GithubApiRepositoryModule>()),
    resolveIssueGitHubApiRepositorySource: (
      repoPath: string,
      preference: unknown,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => resolveIssueSourceMock(repoPath, preference, connectionId, localGitOptions),
    getIssueGitHubApiRepository: (repoPath: string, connectionId?: string | null) =>
      getIssueOwnerRepoMock(repoPath, connectionId)
  }
})

vi.mock('../../repositories/github-api-repository-remote-probe', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof GithubApiRepositoryRemoteProbeModule>()),
    getOriginGitHubApiRepository: (
      repoPath: string,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => getOwnerRepoMock(repoPath, connectionId, localGitOptions),
    getGitHubApiRepositoryForRemote: (
      repoPath: string,
      remoteName: string,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) =>
      remoteName === 'origin'
        ? getOwnerRepoMock(repoPath, connectionId, localGitOptions)
        : getOwnerRepoForRemoteMock(repoPath, remoteName, connectionId, localGitOptions)
  }
})
import { listWorkItems } from './list-work-items'
import { _resetMergeQueueCacheForTests } from '../detect/repository-merge-metadata-cache'
import { _resetOwnerRepoCache } from '../../repositories/github-repository-identity'
import { _resetRemoteNameListingCache } from '../../../git/remotes/remote-name-listing'

import { _resetOriginGitHubApiRepositoryCache } from '../../repositories/github-api-repository-remote-probe'

beforeEach(() => {
  _resetOriginGitHubApiRepositoryCache()
})

describe('listWorkItems', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    getOwnerRepoForRemoteMock.mockReset()
    resolveIssueSourceMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRateLimitSpendMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    // Preserve one source lookup through the preference-aware resolver.
    resolveIssueSourceMock.mockImplementation(async () => ({
      source: await getIssueOwnerRepoMock(),
      fellBack: false
    }))
    // Bridge explicit origin to getOwnerRepoMock; upstream candidates require opt-in fixtures.
    getOwnerRepoForRemoteMock.mockImplementation(
      async (repoPath: string, remoteName: string, connectionId?: string | null, opts = {}) =>
        remoteName === 'origin' ? getOwnerRepoMock(repoPath, connectionId, opts) : null
    )
    _resetOwnerRepoCache()
    _resetRemoteNameListingCache()
    _resetMergeQueueCacheForTests()
  })

  it('does not run unscoped work-item queries when a local repository has no GitHub source', async () => {
    getIssueOwnerRepoMock.mockResolvedValue(null)
    getOwnerRepoMock.mockResolvedValue(null)

    // Null-source envelopes distinguish unavailable repository identity from successful empty work.
    await expect(listWorkItems('/private-repo', 36)).resolves.toMatchObject({
      items: [],
      sources: { issues: null, prs: null }
    })
    await expect(listWorkItems('/private-repo', 36, 'is:open')).resolves.toMatchObject({
      items: [],
      sources: { issues: null, prs: null }
    })

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('rejects unresolved SSH repositories without running unscoped GitHub work-item queries', async () => {
    getIssueOwnerRepoMock.mockResolvedValue(null)
    getOwnerRepoMock.mockResolvedValue(null)
    getOwnerRepoForRemoteMock.mockResolvedValue(null)

    await expect(
      listWorkItems('/remote/repo', 10, undefined, undefined, undefined, 'ssh-1')
    ).rejects.toThrow('GitHub work items require a GitHub remote for SSH repositories')

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()

    ghExecFileAsyncMock.mockClear()
    getIssueOwnerRepoMock.mockResolvedValue(null)
    getOwnerRepoMock.mockResolvedValue(null)
    getOwnerRepoForRemoteMock.mockResolvedValue(null)

    await expect(
      listWorkItems('/remote/repo', 10, 'is:open', undefined, undefined, 'ssh-1')
    ).rejects.toThrow('GitHub work items require a GitHub remote for SSH repositories')

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
