import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'

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
  repositoryRateLimitGuardMock,
  noteRepositoryRateLimitSpendMock,
  spendsSharedGitHubComQuotaMock,
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
  repositoryRateLimitGuardMock: vi.fn((_repo: unknown, bucket: string) =>
    rateLimitGuardMock(bucket)
  ),
  noteRepositoryRateLimitSpendMock: vi.fn(),
  spendsSharedGitHubComQuotaMock: vi.fn(() => true),
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
  classifyListIssuesError: (stderr: string) => ({ type: 'unknown', message: stderr })
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./rate-limit', () => ({
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock,
  getRateLimit: vi.fn(async () => ({ ok: false, error: 'not probed in tests' })),
  // Mirror production: shared-scope calls delegate to the global guard/spend.
  repositoryRateLimitGuard: repositoryRateLimitGuardMock,
  noteRepositoryRateLimitSpend: noteRepositoryRateLimitSpendMock,
  spendsSharedGitHubComQuota: spendsSharedGitHubComQuotaMock
}))

vi.mock('./github-api-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof GithubApiRepositoryModule>()
  return {
    ...actual,
    // Why: these suites drive source resolution through the legacy gh-utils
    // mocks; bridge the hosted seams onto the same mocks.
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

import {
  countWorkItems,
  listWorkItems,
  _resetMergeQueueCacheForTests,
  _resetOwnerRepoCache
} from './client'
import { GITHUB_WORK_ITEMS_QUERY_MAX_BYTES } from '../../shared/github-work-items-query-bounds'

import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository'

// The origin-repository cache is module-level state; reset it so slugs
// resolved by one test cannot leak into the next.
beforeEach(() => {
  _resetOriginGitHubApiRepositoryCache()
})
// Why: split from client-work-items.test.ts to keep both suites under the
// max-lines cap; this file owns query/paging request-shaping cases.
describe('listWorkItems query paging', () => {
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
    repositoryRateLimitGuardMock.mockClear()
    noteRepositoryRateLimitSpendMock.mockReset()
    spendsSharedGitHubComQuotaMock.mockReset()
    spendsSharedGitHubComQuotaMock.mockReturnValue(true)
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    // Why: preference-aware `listWorkItems` calls `resolveIssueSource`.
    // Route through the same `getIssueOwnerRepoMock` so existing tests that
    // only set up `getIssueOwnerRepoMock` continue to work.
    resolveIssueSourceMock.mockImplementation(async () => ({
      source: await getIssueOwnerRepoMock(),
      fellBack: false
    }))
    getOwnerRepoForRemoteMock.mockResolvedValue(null)
    _resetOwnerRepoCache()
    _resetMergeQueueCacheForTests()
  })

  it('returns zero for oversized count queries before resolving repo sources', async () => {
    const secret = 'main-github-work-items-secret'
    const oversizedQuery = secret + 'x'.repeat(GITHUB_WORK_ITEMS_QUERY_MAX_BYTES)

    await expect(countWorkItems('/repo-root', oversizedQuery)).resolves.toBe(0)

    expect(resolveIssueSourceMock).not.toHaveBeenCalled()
    expect(getIssueOwnerRepoMock).not.toHaveBeenCalled()
    expect(getOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(acquireMock).not.toHaveBeenCalled()
    expect(releaseMock).not.toHaveBeenCalled()
  })

  it('uses an implicit WSL UNC cwd for search quota accounting', async () => {
    const repository = { owner: 'acme', repo: 'widgets', host: 'github.com' }
    const repoPath = String.raw`\\wsl.localhost\Ubuntu\home\me\widgets`
    getIssueOwnerRepoMock.mockResolvedValueOnce(repository)
    getOwnerRepoMock.mockResolvedValueOnce(repository)
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '3' })
    spendsSharedGitHubComQuotaMock.mockReturnValue(false)

    await expect(countWorkItems(repoPath, 'is:issue is:open')).resolves.toBe(3)

    const executionOptions = { cwd: repoPath, host: 'github.com' }
    expect(spendsSharedGitHubComQuotaMock).toHaveBeenCalledWith(repository, executionOptions)
    expect(repositoryRateLimitGuardMock).toHaveBeenCalledWith(
      repository,
      'search',
      executionOptions
    )
    expect(noteRepositoryRateLimitSpendMock).toHaveBeenCalledWith(
      repository,
      'search',
      1,
      executionOptions
    )
  })

  it('passes review-requested as a --search qualifier (gh CLI has no dedicated flag)', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await listWorkItems('/repo-root', 10, 'review-requested:@me is:open')

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      expect.arrayContaining(['--search', 'is:pr is:open review-requested:@me sort:created-desc']),
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['--review-requested']),
      expect.anything()
    )
  })

  it('uses the requested numbered Search API page for issues', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await listWorkItems('/repo-root', 10, 'is:issue is:open', 2)

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        '--cache',
        '120s',
        `search/issues?q=${encodeURIComponent('repo:acme/widgets is:issue is:open')}&sort=created&order=desc&per_page=10&page=2`,
        '--jq',
        '.items'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('fetches and slices stable PR results for the requested numbered page', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify(
        [1, 2, 3, 4].map((number) => ({
          number,
          title: `PR ${number}`,
          state: 'OPEN',
          url: `https://github.com/acme/widgets/pull/${number}`,
          labels: [],
          updatedAt: `2026-07-0${number}T00:00:00Z`,
          author: { login: 'octocat' },
          isDraft: false,
          headRefName: `feature/${number}`,
          headRefOid: `head-${number}`,
          baseRefName: 'main'
        }))
      )
    })

    const { items } = await listWorkItems('/repo-root', 2, 'is:pr is:open', 2)

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      expect.arrayContaining(['--limit', '4', '--search', 'is:pr is:open sort:created-desc']),
      { cwd: '/repo-root' }
    )
    expect(items.map((item) => item.number)).toEqual([4, 3])
  })

  it('filters pull request rows out of issue Search API results', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 2,
          title: 'PR-shaped search row',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/2',
          labels: [],
          updated_at: '2026-07-02T00:00:00Z',
          user: { login: 'octocat' },
          pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/2' }
        },
        {
          number: 1,
          title: 'Issue row',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/issues/1',
          labels: [],
          updated_at: '2026-07-01T00:00:00Z',
          user: { login: 'octocat' }
        }
      ])
    })

    const { items } = await listWorkItems('/repo-root', 10, 'is:issue is:open')

    expect(items.map((item) => item.id)).toEqual(['issue:1'])
  })
})
