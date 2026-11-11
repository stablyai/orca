import type * as WorkItemDetailsTestLookup from './work-item-details-test-lookup'
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

vi.mock('./client', async () => ({
  getWorkItem: getWorkItemMock,
  getWorkItemWithRepository: (
    await vi.importActual<typeof WorkItemDetailsTestLookup>('./work-item-details-test-lookup')
  ).makeWorkItemDetailsLookupMock(getWorkItemMock),
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

  // Number-based detail lookups must retain the list's source, avoiding same-number fork/upstream collisions.
})
