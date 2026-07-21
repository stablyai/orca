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
    // Why: preference-aware `listWorkItems` calls `resolveIssueSource`.
    // Route through the same `getIssueOwnerRepoMock` so existing tests that
    // only set up `getIssueOwnerRepoMock` continue to work.
    resolveIssueSourceMock.mockImplementation(async () => ({
      source: await getIssueOwnerRepoMock(),
      fellBack: false
    }))
    // Why: since #7331 `resolvePrWorkItemSource` fetches origin through
    // `getOwnerRepoForRemote` (getOwnerRepo became upstream-first). Delegate
    // the origin probe to `getOwnerRepoMock` so existing tests keep defining
    // the PR-side origin through it; default upstream to null.
    getOwnerRepoForRemoteMock.mockImplementation(
      async (repoPath: string, remoteName: string, connectionId?: string | null, opts = {}) =>
        remoteName === 'origin' ? getOwnerRepoMock(repoPath, connectionId, opts) : null
    )
    _resetOwnerRepoCache()
    _resetMergeQueueCacheForTests()
  })

  it('routes GHES work-item listing through the Enterprise host', async () => {
    const ghes = { owner: 'team', repo: 'orca', host: 'github.acme-corp.com' }
    getIssueOwnerRepoMock.mockResolvedValue(ghes)
    getOwnerRepoMock.mockResolvedValue(ghes)
    ghExecFileAsyncMock.mockResolvedValue({ stdout: '[]' })

    await listWorkItems('/repo-root', 10)

    const calls = ghExecFileAsyncMock.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    // Why: every list spawn must pin options.host so the runner targets the
    // Enterprise server instead of gh's default host.
    expect(calls.every(([, options]) => options?.host === 'github.acme-corp.com')).toBe(true)
  })

  it('does not run unscoped work-item queries when a local repository has no GitHub source', async () => {
    getIssueOwnerRepoMock.mockResolvedValue(null)
    getOwnerRepoMock.mockResolvedValue(null)

    // Why: unresolved sources must return empty null-source envelopes (not throw, not query) so the renderer can
    // distinguish "no GitHub source detected" from genuine zero via `sources` (#9660 follow-up).
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

  it('queries only the resolved PR source when the issue source is unavailable', async () => {
    getIssueOwnerRepoMock.mockResolvedValue(null)
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: '[]' })

    await expect(listWorkItems('/private-repo', 36)).resolves.toMatchObject({ items: [] })

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      expect.arrayContaining(['pr', 'list', '--repo', 'acme/widgets']),
      { cwd: '/private-repo' }
    )
  })

  it('runs both issue and PR GitHub searches for a mixed query and merges the results by recency', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 12,
            title: 'Fix bug',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/issues/12',
            labels: [],
            updatedAt: '2026-03-29T00:00:00Z',
            author: { login: 'octocat' },
            assignees: [
              {
                login: 'test-assignee',
                name: 'Test Assignee',
                databaseId: 1
              }
            ]
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Add feature',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/42',
            labels: [],
            updatedAt: '2026-03-28T00:00:00Z',
            author: { login: 'octocat' },
            isDraft: false,
            headRefName: 'feature/add-feature',
            headRefOid: 'head-42',
            baseRefName: 'main',
            reviewRequests: [
              {
                requestedReviewer: {
                  login: 'test-assignee',
                  name: 'Test Assignee',
                  avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4'
                }
              }
            ]
          }
        ])
      })
    const { items, sources } = await listWorkItems('/repo-root', 10, 'assignee:@me')
    expect(sources).toMatchObject({
      issues: { owner: 'acme', repo: 'widgets' },
      prs: { owner: 'acme', repo: 'widgets' }
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'api',
        '--cache',
        '120s',
        `search/issues?q=${encodeURIComponent('repo:acme/widgets is:issue assignee:@me')}&sort=created&order=desc&per_page=10&page=1`,
        '--jq',
        '.items'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      [
        'pr',
        'list',
        '--limit',
        '10',
        '--state',
        'all',
        '--json',
        'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRefOid,headRepositoryOwner,reviewRequests',
        '--repo',
        'acme/widgets',
        '--search',
        'is:pr assignee:@me sort:created-desc'
      ],
      { cwd: '/repo-root' }
    )
    const prListFields = ghExecFileAsyncMock.mock.calls[1][0].join(',')
    expect(prListFields).not.toContain('statusCheckRollup')
    expect(prListFields).toContain('reviewRequests')
    expect(prListFields).not.toContain('mergeStateStatus')
    expect(items).toEqual([
      {
        id: 'pr:42',
        type: 'pr',
        number: 42,
        title: 'Add feature',
        state: 'open',
        url: 'https://github.com/acme/widgets/pull/42',
        labels: [],
        updatedAt: '2026-03-28T00:00:00Z',
        author: 'octocat',
        branchName: 'feature/add-feature',
        baseRefName: 'main',
        headSha: 'head-42',
        prRepo: { owner: 'acme', repo: 'widgets' },
        reviewRequests: [
          {
            login: 'test-assignee',
            name: 'Test Assignee',
            avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4'
          }
        ]
      },
      {
        id: 'issue:12',
        type: 'issue',
        number: 12,
        title: 'Fix bug',
        state: 'open',
        url: 'https://github.com/acme/widgets/issues/12',
        labels: [],
        updatedAt: '2026-03-29T00:00:00Z',
        author: 'octocat',
        assignees: [
          {
            login: 'test-assignee',
            name: 'Test Assignee',
            avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4'
          }
        ]
      }
    ])
  })

  it('routes local WSL work-item listing through repo resolution and gh execution options', async () => {
    const localGitOptions = { wslDistro: 'Ubuntu' }
    resolveIssueSourceMock.mockResolvedValue({
      source: { owner: 'acme', repo: 'widgets' },
      fellBack: false
    })
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoForRemoteMock.mockImplementation(
      async (repoPath: string, remoteName: string, connectionId?: string | null, opts = {}) =>
        remoteName === 'origin' ? getOwnerRepoMock(repoPath, connectionId, opts) : null
    )
    ghExecFileAsyncMock.mockResolvedValue({ stdout: '[]' })

    await listWorkItems(
      '/repo-root',
      5,
      undefined,
      undefined,
      undefined,
      null,
      false,
      localGitOptions
    )

    expect(resolveIssueSourceMock).toHaveBeenCalledWith(
      '/repo-root',
      undefined,
      null,
      localGitOptions
    )
    // Why: the suite bridge routes origin through getOwnerRepoMock and non-origin
    // remotes through getOwnerRepoForRemoteMock.
    expect(getOwnerRepoMock).toHaveBeenCalledWith('/repo-root', null, localGitOptions)
    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith(
      '/repo-root',
      'upstream',
      null,
      localGitOptions
    )
    expect(ghExecFileAsyncMock.mock.calls.every((call) => call[1]?.wslDistro === 'Ubuntu')).toBe(
      true
    )
  })

  it('rejects oversized queries before resolving repo sources or executing gh', async () => {
    const secret = 'main-github-work-items-secret'
    const oversizedQuery = secret + 'x'.repeat(GITHUB_WORK_ITEMS_QUERY_MAX_BYTES)

    await expect(listWorkItems('/repo-root', 10, oversizedQuery)).resolves.toEqual({
      items: [],
      sources: {
        issues: null,
        prs: null,
        originCandidate: null,
        upstreamCandidate: null
      }
    })

    expect(resolveIssueSourceMock).not.toHaveBeenCalled()
    expect(getIssueOwnerRepoMock).not.toHaveBeenCalled()
    expect(getOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(acquireMock).not.toHaveBeenCalled()
    expect(releaseMock).not.toHaveBeenCalled()
  })

  it('hydrates PR list rows with repository merge metadata', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Add feature',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/42',
            labels: [],
            updatedAt: '2026-03-28T00:00:00Z',
            author: { login: 'octocat' },
            isDraft: false,
            headRefName: 'feature/add-feature',
            headRefOid: 'head-42',
            baseRefName: 'main'
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              viewerDefaultMergeMethod: 'REBASE',
              mergeCommitAllowed: false,
              rebaseMergeAllowed: true,
              squashMergeAllowed: true,
              autoMergeAllowed: false
            }
          }
        })
      })

    const { items } = await listWorkItems('/repo-root', 10, 'is:pr')

    expect(items).toHaveLength(1)
    expect(items[0]?.mergeMethodSettings).toEqual({
      defaultMethod: 'rebase',
      allowedMethods: {
        squash: true,
        merge: false,
        rebase: true
      }
    })
    expect(items[0]?.autoMergeAllowed).toBe(false)
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(['api', 'graphql', '-f', 'owner=acme', '-f', 'repo=widgets']),
      { cwd: '/repo-root' }
    )
  })

  it('routes draft queries to PR search only', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 7,
          title: 'Draft work',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/7',
          labels: [],
          updatedAt: '2026-03-30T00:00:00Z',
          author: { login: 'octocat' },
          isDraft: true,
          headRefName: 'draft/work',
          headRefOid: 'head-7',
          baseRefName: 'main'
        }
      ])
    })
    const { items } = await listWorkItems('/repo-root', 10, 'is:pr is:draft')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'list',
        '--limit',
        '10',
        '--state',
        'all',
        '--json',
        'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRefOid,headRepositoryOwner,reviewRequests',
        '--repo',
        'acme/widgets',
        '--search',
        'is:pr is:open draft:true sort:created-desc'
      ],
      { cwd: '/repo-root' }
    )
    expect(items).toEqual([
      {
        id: 'pr:7',
        type: 'pr',
        number: 7,
        title: 'Draft work',
        state: 'draft',
        url: 'https://github.com/acme/widgets/pull/7',
        labels: [],
        updatedAt: '2026-03-30T00:00:00Z',
        author: 'octocat',
        branchName: 'draft/work',
        baseRefName: 'main',
        headSha: 'head-7',
        prRepo: { owner: 'acme', repo: 'widgets' }
      }
    ])
  })

  it('routes merged queries to PR search only and maps MERGED PR state', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 8,
          title: 'Merged work',
          state: 'MERGED',
          url: 'https://github.com/acme/widgets/pull/8',
          labels: [],
          updatedAt: '2026-03-31T00:00:00Z',
          author: { login: 'octocat' },
          isDraft: false,
          headRefName: 'feature/merged',
          headRefOid: 'head-8',
          baseRefName: 'main'
        }
      ])
    })

    const { items } = await listWorkItems('/repo-root', 10, 'is:merged')

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'list',
        '--limit',
        '10',
        '--state',
        'all',
        '--json',
        'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRefOid,headRepositoryOwner,reviewRequests',
        '--repo',
        'acme/widgets',
        '--search',
        'is:pr is:merged sort:created-desc'
      ],
      { cwd: '/repo-root' }
    )
    expect(items).toMatchObject([
      {
        id: 'pr:8',
        type: 'pr',
        number: 8,
        state: 'merged'
      }
    ])
  })

  it('passes state:all through to gh instead of using the default open state', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await listWorkItems('/repo-root', 10, 'is:pr state:all')

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(expect.arrayContaining(['--state', 'all']), {
      cwd: '/repo-root'
    })
  })

  it('excludes merged PRs from closed PR searches', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 9,
          title: 'Closed without merge',
          state: 'CLOSED',
          url: 'https://github.com/acme/widgets/pull/9',
          labels: [],
          updatedAt: '2026-04-01T00:00:00Z',
          author: { login: 'octocat' },
          isDraft: false,
          headRefName: 'feature/closed',
          headRefOid: 'head-9',
          baseRefName: 'main'
        },
        {
          number: 8,
          title: 'Merged work',
          state: 'MERGED',
          url: 'https://github.com/acme/widgets/pull/8',
          labels: [],
          updatedAt: '2026-03-31T00:00:00Z',
          author: { login: 'octocat' },
          isDraft: false,
          headRefName: 'feature/merged',
          headRefOid: 'head-8',
          baseRefName: 'main'
        }
      ])
    })

    const { items } = await listWorkItems('/repo-root', 10, 'is:pr is:closed')

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        '--state',
        'all',
        '--search',
        'is:pr is:closed -is:merged sort:created-desc'
      ]),
      { cwd: '/repo-root' }
    )
    expect(items).toMatchObject([{ id: 'pr:9', type: 'pr', state: 'closed' }])
  })

  it('quotes spaced label qualifiers when counting search results', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '12' })

    const count = await countWorkItems('/repo-root', 'is:pr label:"needs review"')

    const apiPath = ghExecFileAsyncMock.mock.calls[0][0][3] as string
    expect(count).toBe(12)
    expect(decodeURIComponent(apiPath)).toContain('label:"needs review"')
  })

  it('does not add the merged exclusion to issue-only closed count queries', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '4' })

    await countWorkItems('/repo-root', 'is:issue is:closed')

    const apiPath = decodeURIComponent(ghExecFileAsyncMock.mock.calls[0][0][3] as string)
    expect(apiPath).toContain('is:issue is:closed')
    expect(apiPath).not.toContain('-is:merged')
  })

  it('returns zero without spawning gh when the search bucket is rate-limit blocked', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    rateLimitGuardMock.mockReturnValue({
      blocked: true,
      remaining: 0,
      limit: 30,
      resetAt: Math.floor(Date.now() / 1000) + 60
    } as unknown as { blocked: boolean })

    await expect(countWorkItems('/repo-root', 'is:issue is:open')).resolves.toBe(0)

    expect(rateLimitGuardMock).toHaveBeenCalledWith('search')
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('returns open issues and PRs for the all-open preset query', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 1,
            title: 'Open issue',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/issues/1',
            labels: [],
            updatedAt: '2026-03-31T00:00:00Z',
            author: { login: 'octocat' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 2,
            title: 'Open PR',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/2',
            labels: [],
            updatedAt: '2026-03-30T00:00:00Z',
            author: { login: 'octocat' },
            isDraft: false,
            headRefName: 'feature/open-pr',
            headRefOid: 'head-2',
            baseRefName: 'main'
          }
        ])
      })
    const { items } = await listWorkItems('/repo-root', 10, 'is:open')
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        '--cache',
        '120s',
        `search/issues?q=${encodeURIComponent('repo:acme/widgets is:issue is:open')}&sort=created&order=desc&per_page=10&page=1`,
        '--jq',
        '.items'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'list',
        '--limit',
        '10',
        '--state',
        'all',
        '--json',
        'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRefOid,headRepositoryOwner,reviewRequests',
        '--repo',
        'acme/widgets',
        '--search',
        'is:pr is:open sort:created-desc'
      ],
      { cwd: '/repo-root' }
    )
    expect(items).toEqual([
      {
        id: 'pr:2',
        type: 'pr',
        number: 2,
        title: 'Open PR',
        state: 'open',
        url: 'https://github.com/acme/widgets/pull/2',
        labels: [],
        updatedAt: '2026-03-30T00:00:00Z',
        author: 'octocat',
        branchName: 'feature/open-pr',
        baseRefName: 'main',
        headSha: 'head-2',
        prRepo: { owner: 'acme', repo: 'widgets' }
      },
      {
        id: 'issue:1',
        type: 'issue',
        number: 1,
        title: 'Open issue',
        state: 'open',
        url: 'https://github.com/acme/widgets/issues/1',
        labels: [],
        updatedAt: '2026-03-31T00:00:00Z',
        author: 'octocat'
      }
    ])
  })

  it('marks fork PRs as cross-repository when REST payload only includes head.label', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 1849,
          title: 'Fork PR with missing head repo',
          state: 'open',
          html_url: 'https://github.com/stablyai/orca/pull/1849',
          updated_at: '2026-04-01T00:00:00Z',
          user: { login: 'contributor' },
          head: {
            ref: 'feat/onboarding-model-choice-782',
            sha: 'head-1849',
            repo: null,
            label: 'contributor:feat/onboarding-model-choice-782'
          },
          base: { ref: 'main' }
        }
      ])
    })

    const { items } = await listWorkItems('/repo-root', 10)
    expect(items).toEqual([
      {
        id: 'pr:1849',
        type: 'pr',
        number: 1849,
        title: 'Fork PR with missing head repo',
        state: 'open',
        url: 'https://github.com/stablyai/orca/pull/1849',
        labels: [],
        updatedAt: '2026-04-01T00:00:00Z',
        author: 'contributor',
        branchName: 'feat/onboarding-model-choice-782',
        baseRefName: 'main',
        headSha: 'head-1849',
        prRepo: { owner: 'stablyai', repo: 'orca' },
        isCrossRepository: true
      }
    ])
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
