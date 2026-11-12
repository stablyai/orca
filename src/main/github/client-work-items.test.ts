import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'

// Keep legacy REST request/failure coverage; API-boundary suites exercise the GraphQL path.
vi.mock('./client/list/work-item-search-page', () => ({ usesGraphqlWorkItemSearch: () => false }))

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

vi.mock('./gh-utils', () => ({
  execFileAsync: execFileAsyncMock,
  ghExecFileAsync: ghExecFileAsyncMock,
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
  getOwnerRepo: getOwnerRepoMock,
  getIssueOwnerRepo: getIssueOwnerRepoMock,
  getOwnerRepoForRemote: getOwnerRepoForRemoteMock,
  resolveIssueSource: resolveIssueSourceMock,
  acquire: acquireMock,
  release: releaseMock,
  _resetOwnerRepoCache: vi.fn(),
  classifyGhError: (stderr: string) => ({ type: 'unknown', message: stderr }),
  classifyListIssuesError: (stderr: string) => ({ type: 'unknown', message: stderr }),
  classifyListPrsError: (stderr: string) => ({ type: 'unknown', message: stderr })
}))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./rate-limit', () => ({
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock,
  getRateLimit: vi.fn(async () => ({ ok: false, error: 'not probed in tests' })),
  repositoryRateLimitGuard: vi.fn((_repo: unknown, bucket: string) => rateLimitGuardMock(bucket)),
  noteRepositoryRateLimitSpend: vi.fn((_repo: unknown, bucket: string, cost?: number) =>
    noteRateLimitSpendMock(bucket, cost)
  ),
  spendsSharedGitHubComQuota: () => true
}))

vi.mock('./github-api-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof GithubApiRepositoryModule>()
  return {
    ...actual,
    // Bridge hosted source resolution to the suite's gh-utils fixtures.
    resolveIssueGitHubApiRepositorySource: (
      repoPath: string,
      preference: unknown,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => resolveIssueSourceMock(repoPath, preference, connectionId, localGitOptions),
    getIssueGitHubApiRepository: (repoPath: string, connectionId?: string | null) =>
      getIssueOwnerRepoMock(repoPath, connectionId),
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
import { listWorkItems } from './client/list/list-work-items'
import { _resetMergeQueueCacheForTests } from './client/detect/repository-merge-metadata-cache'
import { _resetOwnerRepoCache } from './gh-utils'
import { _resetRemoteNameListingCache } from '../git/remotes/remote-name-listing'

import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository'

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
