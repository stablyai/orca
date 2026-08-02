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
  classifyListIssuesError: (stderr: string) => ({ type: 'unknown', message: stderr }),
  classifyListPrsError: (stderr: string) => ({ type: 'unknown', message: stderr })
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
  listWorkItemsAcrossRepos,
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

  it('lifts a swallowed PR-side failure onto errors.prs instead of reading as end-of-data', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    // Non-availability failure (plain 403): swallowed into [], must still surface.
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 403: Forbidden'))

    const envelope = await listWorkItems('/repo-root', 10, 'is:pr is:open', 2)

    expect(envelope.items).toEqual([])
    expect(envelope.errors?.issues).toBeUndefined()
    expect(envelope.errors?.prs).toEqual({
      type: 'unknown',
      message: expect.stringContaining('HTTP 403')
    })
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

  it('merges selected repositories by Search API creation order in one request', async () => {
    const repositories = new Map([
      ['/repo-alpha', { owner: 'acme', repo: 'alpha' }],
      ['/repo-beta', { owner: 'acme', repo: 'beta' }]
    ])
    resolveIssueSourceMock.mockImplementation(async (repoPath: string) => ({
      source: repositories.get(repoPath),
      fellBack: false
    }))
    getIssueOwnerRepoMock.mockImplementation(async (repoPath: string) => repositories.get(repoPath))
    getOwnerRepoMock.mockImplementation(async (repoPath: string) => repositories.get(repoPath))
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        totalCount: 2,
        items: [
          {
            number: 1,
            title: 'New beta issue',
            state: 'open',
            html_url: 'https://github.com/acme/beta/issues/1',
            repository: { full_name: 'acme/beta' },
            labels: [],
            created_at: '2026-08-02T12:00:00Z',
            updated_at: '2026-08-02T12:00:00Z',
            user: { login: 'octocat' }
          },
          {
            number: 99,
            title: 'Old alpha issue',
            state: 'open',
            html_url: 'https://github.com/acme/alpha/issues/99',
            repository: { full_name: 'acme/alpha' },
            labels: [],
            created_at: '2026-08-01T12:00:00Z',
            updated_at: '2026-08-01T12:00:00Z',
            user: { login: 'octocat' }
          }
        ]
      })
    })

    const result = await listWorkItemsAcrossRepos(
      [
        { repoId: 'repo-alpha-id', repoPath: '/repo-alpha' },
        { repoId: 'repo-beta-id', repoPath: '/repo-beta' }
      ],
      2,
      'is:issue is:open'
    )

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(ghExecFileAsyncMock.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        `search/issues?q=${encodeURIComponent('repo:acme/alpha repo:acme/beta is:issue is:open')}&sort=created&order=desc&per_page=2&page=1`
      ])
    )
    expect(result.items.map((item) => [item.repoId, item.number])).toEqual([
      ['repo-beta-id', 1],
      ['repo-alpha-id', 99]
    ])
    expect(result.totalCount).toBe(2)
  })

  it('fetches a prefix when requesting a later globally merged page', async () => {
    const repository = { owner: 'acme', repo: 'widgets' }
    resolveIssueSourceMock.mockResolvedValue({ source: repository, fellBack: false })
    getIssueOwnerRepoMock.mockResolvedValue(repository)
    getOwnerRepoMock.mockResolvedValue(repository)
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        totalCount: 3,
        items: [
          {
            number: 3,
            title: 'Newest',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/issues/3',
            repository: { full_name: 'acme/widgets' },
            labels: [],
            created_at: '2026-08-03T00:00:00Z',
            updated_at: '2026-08-03T00:00:00Z',
            user: { login: 'octocat' }
          },
          {
            number: 2,
            title: 'Second',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/issues/2',
            repository: { full_name: 'acme/widgets' },
            labels: [],
            created_at: '2026-08-02T00:00:00Z',
            updated_at: '2026-08-02T00:00:00Z',
            user: { login: 'octocat' }
          }
        ]
      })
    })

    const result = await listWorkItemsAcrossRepos(
      [{ repoId: 'repo-id', repoPath: '/repo-root' }],
      1,
      'is:issue is:open',
      2
    )

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(ghExecFileAsyncMock.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['--cache', '120s', expect.stringContaining('per_page=100&page=1')])
    )
    expect(result.items.map((item) => item.number)).toEqual([2])
    expect(result.totalCount).toBe(3)
  })
})
