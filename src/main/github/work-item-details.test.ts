import { beforeEach, describe, expect, it, vi } from 'vitest'

type RateLimitGuardResult =
  | { blocked: false }
  | { blocked: true; remaining: number; limit: number; resetAt: number }

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  getEnterpriseGitHubRepoSlugMock,
  getEnterpriseGitHubRepoSlugForRemoteMock,
  getWorkItemMock,
  getWorkItemByOwnerRepoMock,
  getPRChecksMock,
  getPRCommentsMock,
  repositoryRateLimitGuardMock,
  noteRepositoryRateLimitSpendMock,
  ghRepoExecOptionsMock,
  githubRepoContextMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getOwnerRepoForRemoteMock: vi.fn(),
  getEnterpriseGitHubRepoSlugMock: vi.fn(),
  getEnterpriseGitHubRepoSlugForRemoteMock: vi.fn(),
  getWorkItemMock: vi.fn(),
  getWorkItemByOwnerRepoMock: vi.fn(),
  getPRChecksMock: vi.fn(),
  getPRCommentsMock: vi.fn(),
  repositoryRateLimitGuardMock: vi.fn<
    (
      repository: { host?: string } | null | undefined,
      bucket: 'core' | 'graphql' | 'search',
      options?: { cwd?: string; wslDistro?: string }
    ) => RateLimitGuardResult
  >(() => ({ blocked: false })),
  noteRepositoryRateLimitSpendMock: vi.fn(),
  ghRepoExecOptionsMock: vi.fn((context) =>
    context.connectionId
      ? {}
      : { cwd: context.repoPath, ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}) }
  ),
  githubRepoContextMock: vi.fn((repoPath, connectionId, localGitOptions) => ({
    repoPath,
    connectionId: connectionId ?? null,
    ...localGitOptions
  })),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  getOwnerRepo: getOwnerRepoMock,
  getOwnerRepoForRemote: getOwnerRepoForRemoteMock,
  ghRepoExecOptions: ghRepoExecOptionsMock,
  githubRepoContext: githubRepoContextMock,
  acquire: acquireMock,
  release: releaseMock
}))

vi.mock('./client', () => ({
  getWorkItem: getWorkItemMock,
  getWorkItemByOwnerRepo: getWorkItemByOwnerRepoMock,
  getPRChecks: getPRChecksMock,
  getPRComments: getPRCommentsMock
}))

vi.mock('./github-enterprise-repository', () => ({
  getEnterpriseGitHubRepoSlug: getEnterpriseGitHubRepoSlugMock,
  getEnterpriseGitHubRepoSlugForRemote: getEnterpriseGitHubRepoSlugForRemoteMock,
  isGitHubHostAuthenticated: vi.fn().mockResolvedValue(true)
}))

vi.mock('./rate-limit', () => ({
  repositoryRateLimitGuard: repositoryRateLimitGuardMock,
  noteRepositoryRateLimitSpend: noteRepositoryRateLimitSpendMock
}))

import { getWorkItemDetails } from './work-item-details'

import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository'

// The origin-repository cache is module-level state; reset it so slugs
// resolved by one test cannot leak into the next.
beforeEach(() => {
  _resetOriginGitHubApiRepositoryCache()
})

describe('getWorkItemDetails', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getOwnerRepoForRemoteMock.mockReset()
    getEnterpriseGitHubRepoSlugMock.mockReset()
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue(null)
    getEnterpriseGitHubRepoSlugForRemoteMock.mockReset()
    getEnterpriseGitHubRepoSlugForRemoteMock.mockResolvedValue(null)
    getWorkItemMock.mockReset()
    getWorkItemByOwnerRepoMock.mockReset()
    getPRChecksMock.mockReset()
    getPRCommentsMock.mockReset()
    repositoryRateLimitGuardMock.mockReset()
    repositoryRateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRepositoryRateLimitSpendMock.mockReset()
    ghRepoExecOptionsMock.mockClear()
    githubRepoContextMock.mockClear()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
  })

  it('uses the collapsed GraphQL issue query with timeline activity enrichment', async () => {
    getWorkItemMock.mockResolvedValueOnce({
      id: 'issue:923',
      type: 'issue',
      number: 923,
      title: 'Use upstream issues',
      state: 'open',
      url: 'https://github.com/acme/widgets/issues/923',
      labels: [],
      updatedAt: '2026-04-01T00:00:00Z',
      author: 'issue-author'
    })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    const timelineEvents = [
      {
        id: 101,
        event: 'assigned',
        actor: { login: 'timeline-actor', avatar_url: 'https://x/timeline-actor' },
        assignee: { login: 'assigned-user' },
        created_at: '2026-04-01T01:00:00Z'
      },
      {
        id: 102,
        event: 'cross-referenced',
        actor: { login: 'timeline-actor', avatar_url: 'https://x/timeline-actor' },
        created_at: '2026-04-01T02:00:00Z',
        source: {
          issue: {
            number: 6180,
            title: 'Synthetic reference PR',
            html_url: 'https://github.com/acme/widgets/pull/6180',
            repository: { owner: { login: 'acme' }, name: 'widgets' },
            pull_request: {}
          }
        }
      },
      {
        id: 103,
        event: 'moved_columns_in_project',
        actor: { login: 'github-project-automation', avatar_url: 'https://x/bot' },
        created_at: '2026-04-01T03:00:00Z',
        previous_column_name: 'Doing',
        project_column_name: 'Complete',
        project: { name: 'Example Project' }
      },
      {
        id: 104,
        event: 'closed',
        actor: { login: 'timeline-actor', avatar_url: 'https://x/timeline-actor' },
        created_at: '2026-04-01T04:00:00Z',
        state_reason: 'completed',
        closer: {
          number: 6180,
          title: 'Synthetic reference PR',
          html_url: 'https://github.com/acme/widgets/pull/6180',
          repository: { owner: { login: 'acme' }, name: 'widgets' },
          pull_request: {}
        }
      }
    ]
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              issue: {
                body: 'Issue body',
                assignees: { nodes: [{ login: 'assigned-user' }] },
                participants: {
                  nodes: [{ login: 'issue-author', avatarUrl: 'https://x/y', name: 'Issue Author' }]
                },
                comments: {
                  nodes: [
                    {
                      databaseId: 7,
                      body: 'first',
                      createdAt: '2026-04-01T00:00:00Z',
                      url: 'https://github.com/acme/widgets/issues/923#issuecomment-7',
                      author: { login: 'issue-author', avatarUrl: 'https://x/y' }
                    }
                  ]
                }
              }
            }
          }
        })
      })
      .mockResolvedValueOnce({
        stdout: timelineEvents.map((event) => JSON.stringify(event)).join('\n')
      })

    const details = await getWorkItemDetails('/repo-root', 923, 'issue')

    expect(getWorkItemMock).toHaveBeenCalledWith('/repo-root', 923, 'issue', undefined)
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(ghExecFileAsyncMock.mock.calls[0][0][0]).toBe('api')
    expect(ghExecFileAsyncMock.mock.calls[0][0][1]).toBe('graphql')
    expect(ghExecFileAsyncMock.mock.calls[1][0]).toEqual([
      'api',
      '--cache',
      '60s',
      'repos/acme/widgets/issues/923/timeline?per_page=100&page=1',
      '--jq',
      '.[] | @json'
    ])
    expect(details?.body).toBe('Issue body')
    expect(details?.assignees).toEqual(['assigned-user'])
    expect(details?.comments).toHaveLength(1)
    expect(details?.comments[0].id).toBe(7)
    expect(details?.timelineItems).toMatchObject([
      { event: 'assigned', actor: 'timeline-actor', assignee: 'assigned-user' },
      {
        event: 'cross-referenced',
        source: {
          type: 'pr',
          number: 6180,
          repository: 'acme/widgets'
        }
      },
      {
        event: 'moved_columns_in_project',
        actor: 'github-project-automation',
        previousColumnName: 'Doing',
        columnName: 'Complete',
        projectName: 'Example Project'
      },
      {
        event: 'closed',
        stateReason: 'completed',
        closer: { type: 'pr', number: 6180 }
      }
    ])
    expect(details?.participants?.[0]?.login).toBe('issue-author')
    // Why: issue identities resolve hosted, pinned to github.com for dotcom.
    expect(repositoryRateLimitGuardMock).toHaveBeenCalledWith(
      { owner: 'acme', repo: 'widgets', host: 'github.com' },
      'graphql',
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(noteRepositoryRateLimitSpendMock).toHaveBeenCalledWith(
      { owner: 'acme', repo: 'widgets', host: 'github.com' },
      'graphql',
      1,
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(repositoryRateLimitGuardMock).toHaveBeenCalledWith(
      { owner: 'acme', repo: 'widgets', host: 'github.com' },
      'core',
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(noteRepositoryRateLimitSpendMock).toHaveBeenCalledWith(
      { owner: 'acme', repo: 'widgets', host: 'github.com' },
      'core',
      1,
      { cwd: '/repo-root', host: 'github.com' }
    )
  })

  it('scopes collapsed issue GraphQL accounting to an implicit WSL UNC runtime', async () => {
    const repository = { owner: 'acme', repo: 'widgets' }
    const repoPath = String.raw`\\wsl.localhost\Ubuntu\home\me\widgets`
    getWorkItemMock.mockResolvedValueOnce({
      id: 'issue:923',
      type: 'issue',
      number: 923,
      title: 'Use upstream issues',
      state: 'open',
      url: 'https://github.com/acme/widgets/issues/923',
      labels: [],
      updatedAt: '2026-04-01T00:00:00Z',
      author: 'issue-author'
    })
    getOwnerRepoForRemoteMock.mockResolvedValue(repository)
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              issue: {
                body: 'WSL issue body',
                assignees: { nodes: [] },
                participants: { nodes: [] },
                comments: { nodes: [] }
              }
            }
          }
        })
      })
      .mockResolvedValueOnce({ stdout: '' })

    const details = await getWorkItemDetails(repoPath, 923, 'issue')

    expect(details?.body).toBe('WSL issue body')
    // Why: issue identities resolve hosted, pinned to github.com for dotcom.
    expect(repositoryRateLimitGuardMock).toHaveBeenCalledWith(
      { ...repository, host: 'github.com' },
      'graphql',
      { cwd: repoPath, host: 'github.com' }
    )
    expect(noteRepositoryRateLimitSpendMock).toHaveBeenCalledWith(
      { ...repository, host: 'github.com' },
      'graphql',
      1,
      { cwd: repoPath, host: 'github.com' }
    )
    expect(ghExecFileAsyncMock.mock.calls.every((call) => call[1]?.cwd === repoPath)).toBe(true)
  })

  it('enriches a non-participating assignee avatar from the GraphQL assignees connection', async () => {
    // Why: a GHE assignee who never commented is absent from `participants`, so
    // the enrichment must also draw avatars from the `assignees` connection or
    // item.assignees keeps the blank avatar `gh` returns.
    getWorkItemMock.mockResolvedValueOnce({
      id: 'issue:924',
      type: 'issue',
      number: 924,
      title: 'Assignee avatar',
      state: 'open',
      url: 'https://github.com/acme/widgets/issues/924',
      labels: [],
      updatedAt: '2026-04-01T00:00:00Z',
      author: 'issue-author',
      assignees: [{ login: 'ghe-assignee', name: 'GHE Assignee', avatarUrl: '' }]
    })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              issue: {
                body: 'Issue body',
                assignees: {
                  nodes: [
                    {
                      login: 'ghe-assignee',
                      name: 'GHE Assignee',
                      avatarUrl: 'https://ghe.example.com/avatars/ghe-assignee'
                    }
                  ]
                },
                participants: { nodes: [{ login: 'issue-author', avatarUrl: 'https://x/y' }] },
                comments: { nodes: [] }
              }
            }
          }
        })
      })
      .mockResolvedValueOnce({ stdout: '' })

    const details = await getWorkItemDetails('/repo-root', 924, 'issue')

    expect(details?.item.assignees?.[0]).toMatchObject({
      login: 'ghe-assignee',
      avatarUrl: 'https://ghe.example.com/avatars/ghe-assignee'
    })
  })

  it('caps issue timeline pagination by supported activity items', async () => {
    getWorkItemMock.mockResolvedValueOnce({
      id: 'issue:923',
      type: 'issue',
      number: 923,
      title: 'Use upstream issues',
      state: 'open',
      url: 'https://github.com/acme/widgets/issues/923',
      labels: [],
      updatedAt: '2026-04-01T00:00:00Z',
      author: 'issue-author'
    })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    const makeTimelineEvent = (page: number, index: number, event: string): string =>
      JSON.stringify({
        id: `${page}:${index}`,
        event,
        actor: { login: 'issue-author', avatar_url: 'https://x/y' },
        assignee: { login: `assignee-${page}-${index}` },
        created_at: '2026-04-01T00:00:00Z'
      })
    const makeTimelinePage = (page: number, supportedCount: number): string =>
      Array.from({ length: 100 }, (_, index) =>
        makeTimelineEvent(page, index, index < supportedCount ? 'assigned' : 'subscribed')
      ).join('\n')
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              issue: {
                body: 'Issue body',
                assignees: { nodes: [] },
                participants: { nodes: [] },
                comments: { nodes: [] }
              }
            }
          }
        })
      })
      .mockResolvedValueOnce({ stdout: makeTimelinePage(1, 0) })
      .mockResolvedValueOnce({ stdout: makeTimelinePage(2, 0) })
      .mockResolvedValueOnce({ stdout: makeTimelinePage(3, 10) })
      .mockResolvedValueOnce({ stdout: makeTimelinePage(4, 100) })
      .mockResolvedValueOnce({ stdout: makeTimelinePage(5, 100) })
      .mockResolvedValueOnce({ stdout: makeTimelinePage(6, 100) })

    const details = await getWorkItemDetails('/repo-root', 923, 'issue')

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(7)
    expect(ghExecFileAsyncMock.mock.calls[1][0]).toContain(
      'repos/acme/widgets/issues/923/timeline?per_page=100&page=1'
    )
    expect(ghExecFileAsyncMock.mock.calls[2][0]).toContain(
      'repos/acme/widgets/issues/923/timeline?per_page=100&page=2'
    )
    expect(ghExecFileAsyncMock.mock.calls[3][0]).toContain(
      'repos/acme/widgets/issues/923/timeline?per_page=100&page=3'
    )
    expect(ghExecFileAsyncMock.mock.calls[6][0]).toContain(
      'repos/acme/widgets/issues/923/timeline?per_page=100&page=6'
    )
    expect(
      ghExecFileAsyncMock.mock.calls.some((call) =>
        call[0].includes('repos/acme/widgets/issues/923/timeline?per_page=100&page=7')
      )
    ).toBe(false)
    const timelineItems = details?.timelineItems
    if (!timelineItems) {
      throw new Error('Expected timeline items to be present')
    }
    expect(timelineItems).toHaveLength(300)
    expect(timelineItems.at(0)).toMatchObject({ assignee: 'assignee-3-0' })
    expect(timelineItems.at(-1)).toMatchObject({ assignee: 'assignee-6-89' })
  })

  it('falls back to REST + GraphQL when the collapsed issue query fails', async () => {
    getWorkItemMock.mockResolvedValueOnce({
      id: 'issue:923',
      type: 'issue',
      number: 923,
      title: 'Use upstream issues',
      state: 'open',
      url: 'https://github.com/acme/widgets/issues/923',
      labels: [],
      updatedAt: '2026-04-01T00:00:00Z',
      author: 'issue-author'
    })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    // Collapsed GraphQL throws → fallback path picks up.
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL error'))
      .mockResolvedValueOnce({ stdout: JSON.stringify({ body: 'Issue body' }) })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: { repository: { issue: { participants: { nodes: [] } } } }
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ data: {} })
      })

    const details = await getWorkItemDetails('/repo-root', 923, 'issue')

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', '--cache', '60s', 'repos/acme/widgets/issues/923'],
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['api', '--cache', '60s', 'repos/acme/widgets/issues/923/comments?per_page=100'],
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      4,
      [
        'api',
        '--cache',
        '60s',
        'repos/acme/widgets/issues/923/timeline?per_page=100&page=1',
        '--jq',
        '.[] | @json'
      ],
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(details?.body).toBe('Issue body')
  })

  it('skips optional GraphQL issue detail calls when the cached GraphQL budget is low', async () => {
    repositoryRateLimitGuardMock.mockImplementation((_repository, bucket) =>
      bucket === 'graphql'
        ? {
            blocked: true,
            remaining: 3,
            limit: 5000,
            resetAt: 1_800_000_000
          }
        : { blocked: false }
    )
    getWorkItemMock.mockResolvedValueOnce({
      id: 'issue:923',
      type: 'issue',
      number: 923,
      title: 'Use upstream issues',
      state: 'open',
      url: 'https://github.com/acme/widgets/issues/923',
      labels: [],
      updatedAt: '2026-04-01T00:00:00Z',
      author: 'issue-author'
    })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify({ body: 'Issue body', assignees: [] }) })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({ stdout: '[]' })

    const details = await getWorkItemDetails('/repo-root', 923, 'issue')

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(3)
    expect(ghExecFileAsyncMock.mock.calls.some((call) => call[0][1] === 'graphql')).toBe(false)
    expect(
      noteRepositoryRateLimitSpendMock.mock.calls.some(([, bucket]) => bucket === 'graphql')
    ).toBe(false)
    expect(noteRepositoryRateLimitSpendMock).toHaveBeenCalledWith(
      { owner: 'acme', repo: 'widgets', host: 'github.com' },
      'core',
      2,
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(details?.body).toBe('Issue body')
    expect(details?.participants).toEqual([])
  })

  it('uses SSH connection context for issue details without local cwd', async () => {
    getWorkItemMock.mockResolvedValueOnce({
      id: 'issue:923',
      type: 'issue',
      number: 923,
      title: 'Use upstream issues',
      state: 'open',
      url: 'https://github.com/acme/widgets/issues/923',
      labels: [],
      updatedAt: '2026-04-01T00:00:00Z',
      author: 'issue-author'
    })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              issue: {
                body: 'Remote issue body',
                assignees: { nodes: [] },
                participants: { nodes: [] },
                comments: { nodes: [] }
              }
            }
          }
        })
      })
      .mockResolvedValueOnce({ stdout: '[]' })

    const details = await getWorkItemDetails('/home/tester/widgets', 923, 'issue', 'ssh-test-1')

    expect(getWorkItemMock).toHaveBeenCalledWith('/home/tester/widgets', 923, 'issue', 'ssh-test-1')
    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith(
      '/home/tester/widgets',
      'upstream',
      'ssh-test-1',
      {}
    )
    expect(ghExecFileAsyncMock.mock.calls[0][1]).toEqual({ host: 'github.com' })
    expect(details?.body).toBe('Remote issue body')
  })

  it('routes local WSL PR detail fan-out through the selected distro', async () => {
    const localGitOptions = { wslDistro: 'Ubuntu' }
    getWorkItemMock.mockResolvedValueOnce({
      id: 'pr:42',
      type: 'pr',
      number: 42,
      title: 'Review drawer WSL',
      state: 'open',
      url: 'https://github.com/acme/widgets/pull/42',
      labels: [],
      updatedAt: '2026-04-01T00:00:00Z',
      author: 'pr-author'
    })
    // Why: PR detail resolution uses getOwnerRepoForRemote via origin repository lookup.
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    getPRCommentsMock.mockResolvedValue([])
    getPRChecksMock.mockResolvedValue([])
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const target = args.at(-1)
      if (target === 'repos/acme/widgets/pulls/42') {
        return {
          stdout: JSON.stringify({
            body: 'PR body',
            head: { sha: 'head-sha' },
            base: { sha: 'base-sha' }
          })
        }
      }
      if (target === 'repos/acme/widgets/pulls/42/files?per_page=100') {
        return { stdout: '[]' }
      }
      const query = args.find((arg) => arg.startsWith('query=')) ?? ''
      if (query.includes('viewerViewedState')) {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  id: 'PR_kwDO123',
                  files: { pageInfo: { hasNextPage: false }, nodes: [] }
                }
              }
            }
          })
        }
      }
      if (query.includes('participants(first: 100)')) {
        return {
          stdout: JSON.stringify({
            data: { repository: { pullRequest: { participants: { nodes: [] } } } }
          })
        }
      }
      return { stdout: JSON.stringify({ data: {} }) }
    })

    const details = await getWorkItemDetails('/repo-root', 42, 'pr', null, localGitOptions)

    expect(details?.body).toBe('PR body')
    expect(getWorkItemMock).toHaveBeenCalledWith('/repo-root', 42, 'pr', null, localGitOptions)
    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith(
      '/repo-root',
      'origin',
      null,
      localGitOptions
    )
    expect(getPRCommentsMock).toHaveBeenCalledWith(
      '/repo-root',
      42,
      { prRepo: { owner: 'acme', repo: 'widgets', host: 'github.com' } },
      null,
      localGitOptions
    )
    expect(getPRChecksMock).toHaveBeenCalledWith(
      '/repo-root',
      42,
      'head-sha',
      { owner: 'acme', repo: 'widgets', host: 'github.com' },
      undefined,
      null,
      localGitOptions
    )
    expect(ghExecFileAsyncMock.mock.calls.every((call) => call[1]?.wslDistro === 'Ubuntu')).toBe(
      true
    )
  })

  // Why: a rate-limited/auth-failed file fetch must not render as an empty PR;
  // the Files tab keys its retry state off details.filesUnavailable.
  it('flags filesUnavailable when the PR file fetch fails but leaves the PR empty otherwise intact', async () => {
    getWorkItemMock.mockResolvedValueOnce({
      id: 'pr:8305',
      type: 'pr',
      number: 8305,
      title: 'Files fetch fails',
      state: 'open',
      url: 'https://github.com/acme/widgets/pull/8305',
      labels: [],
      updatedAt: '2026-07-11T00:00:00Z',
      author: 'pr-author'
    })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    getPRCommentsMock.mockResolvedValue([])
    getPRChecksMock.mockResolvedValue([])
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const target = args.at(-1)
      if (target === 'repos/acme/widgets/pulls/8305') {
        return {
          stdout: JSON.stringify({ head: { sha: 'head-sha' }, base: { sha: 'base-sha' } })
        }
      }
      if (target === 'repos/acme/widgets/pulls/8305/files?per_page=100') {
        throw new Error('gh: API rate limit exceeded (403)')
      }
      return { stdout: JSON.stringify({ data: {} }) }
    })

    const details = await getWorkItemDetails('/repo-root', 8305, 'pr')

    expect(details?.filesUnavailable).toBe(true)
    expect(details?.files).toBeUndefined()
  })

  it('treats an empty file list as a genuinely empty PR, not an unavailable one', async () => {
    getWorkItemMock.mockResolvedValueOnce({
      id: 'pr:8306',
      type: 'pr',
      number: 8306,
      title: 'Empty PR',
      state: 'open',
      url: 'https://github.com/acme/widgets/pull/8306',
      labels: [],
      updatedAt: '2026-07-11T00:00:00Z',
      author: 'pr-author'
    })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    getPRCommentsMock.mockResolvedValue([])
    getPRChecksMock.mockResolvedValue([])
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const target = args.at(-1)
      if (target === 'repos/acme/widgets/pulls/8306') {
        return {
          stdout: JSON.stringify({ head: { sha: 'head-sha' }, base: { sha: 'base-sha' } })
        }
      }
      if (target === 'repos/acme/widgets/pulls/8306/files?per_page=100') {
        return { stdout: '[]' }
      }
      return { stdout: JSON.stringify({ data: {} }) }
    })

    const details = await getWorkItemDetails('/repo-root', 8306, 'pr')

    expect(details?.filesUnavailable).toBe(false)
    expect(details?.files).toEqual([])
  })

  // Why: `gh pr view` omits avatar_url, so the login-based github.com URL 404s on
  // GHE. getWorkItemDetails must resolve author/reviewer/assignee avatars via the
  // GraphQL user(login:) batch and stamp them onto the returned item. See #8784.
  it('enriches PR author, reviewer, and assignee avatars from the GraphQL user lookup', async () => {
    getWorkItemMock.mockResolvedValueOnce({
      id: 'pr:1102',
      type: 'pr',
      number: 1102,
      title: 'Enterprise PR',
      state: 'open',
      url: 'https://ghe.example.com/acme/widgets/pull/1102',
      labels: [],
      updatedAt: '2026-07-11T00:00:00Z',
      author: 'seah',
      reviewRequests: [{ login: 'ludi', name: null, avatarUrl: '' }],
      latestReviews: [{ login: 'inho', state: 'APPROVED', avatarUrl: '' }],
      // A default `u/0` placeholder must be replaced by the resolved avatar.
      assignees: [{ login: 'seah', name: 'Seah', avatarUrl: 'https://avatars.example.com/u/0?v=4' }]
    })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    getPRCommentsMock.mockResolvedValue([])
    getPRChecksMock.mockResolvedValue([])
    const avatars: Record<string, string> = {
      seah: 'https://avatars.example.com/u/1?v=4',
      ludi: 'https://avatars.example.com/u/2?v=4',
      inho: 'https://avatars.example.com/u/3?v=4'
    }
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const target = args.at(-1)
      if (target === 'repos/acme/widgets/pulls/1102') {
        return {
          stdout: JSON.stringify({ body: 'PR body', head: { sha: 'h' }, base: { sha: 'b' } })
        }
      }
      if (target === 'repos/acme/widgets/pulls/1102/files?per_page=100') {
        return { stdout: '[]' }
      }
      const query = args.find((arg) => arg.startsWith('query=')) ?? ''
      if (query.includes('user(login:')) {
        // Return the aliased users the batch asked for, keyed by their login.
        const data: Record<string, { login: string; name: null; avatarUrl: string }> = {}
        let index = 0
        for (const login of Object.keys(avatars)) {
          if (query.includes(`user(login: "${login}")`)) {
            data[`u${index}`] = { login, name: null, avatarUrl: avatars[login] }
            index += 1
          }
        }
        return { stdout: JSON.stringify({ data }) }
      }
      return { stdout: JSON.stringify({ data: {} }) }
    })

    const details = await getWorkItemDetails('/repo-root', 1102, 'pr')

    expect(details?.item.authorAvatarUrl).toBe(avatars.seah)
    expect(details?.item.reviewRequests?.[0]?.avatarUrl).toBe(avatars.ludi)
    expect(details?.item.latestReviews?.[0]?.avatarUrl).toBe(avatars.inho)
    // The default u/0 placeholder is overridden by the resolved avatar.
    expect(details?.item.assignees?.[0]?.avatarUrl).toBe(avatars.seah)
  })
})
