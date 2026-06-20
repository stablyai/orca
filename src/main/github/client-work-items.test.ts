/* eslint-disable max-lines -- Why: work-items coverage stays in one file so
the fan-out mock plumbing (issue + PR gh calls, allSettled handling) does
not drift across split files. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  rateLimitGuardMock: vi.fn(() => ({ blocked: false })),
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
  noteRateLimitSpend: noteRateLimitSpendMock
}))

import {
  countWorkItems,
  listWorkItems,
  _resetMergeQueueCacheForTests,
  _resetOwnerRepoCache
} from './client'
import { GITHUB_WORK_ITEMS_QUERY_MAX_BYTES } from '../../shared/github-work-items-query-bounds'

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
    getOwnerRepoForRemoteMock.mockResolvedValue(null)
    _resetOwnerRepoCache()
    _resetMergeQueueCacheForTests()
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
        'issue',
        'list',
        '--limit',
        '10',
        '--json',
        'number,title,state,url,labels,updatedAt,author,assignees',
        '--repo',
        'acme/widgets',
        '--assignee',
        '@me'
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
        '--json',
        'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRefOid,headRepositoryOwner,reviewRequests',
        '--repo',
        'acme/widgets',
        '--assignee',
        '@me'
      ],
      { cwd: '/repo-root' }
    )
    const prListFields = ghExecFileAsyncMock.mock.calls[1][0].join(',')
    expect(prListFields).not.toContain('statusCheckRollup')
    expect(prListFields).toContain('reviewRequests')
    expect(prListFields).not.toContain('mergeStateStatus')
    expect(items).toEqual([
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
      },
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
    getOwnerRepoForRemoteMock.mockResolvedValue(null)
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
        '--json',
        'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRefOid,headRepositoryOwner,reviewRequests',
        '--repo',
        'acme/widgets',
        '--state',
        'open',
        '--draft'
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
        '--json',
        'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRefOid,headRepositoryOwner,reviewRequests',
        '--repo',
        'acme/widgets',
        '--state',
        'merged'
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
      expect.arrayContaining(['--state', 'closed', '--search', '-is:merged']),
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

  it('passes review-requested as a --search qualifier (gh CLI has no dedicated flag)', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await listWorkItems('/repo-root', 10, 'review-requested:@me is:open')

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      expect.arrayContaining(['--search', 'review-requested:@me']),
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['--review-requested']),
      expect.anything()
    )
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
        'issue',
        'list',
        '--limit',
        '10',
        '--json',
        'number,title,state,url,labels,updatedAt,author,assignees',
        '--repo',
        'acme/widgets',
        '--state',
        'open'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'list',
        '--limit',
        '10',
        '--json',
        'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRefOid,headRepositoryOwner,reviewRequests',
        '--repo',
        'acme/widgets',
        '--state',
        'open'
      ],
      { cwd: '/repo-root' }
    )
    expect(items).toEqual([
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
      },
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
