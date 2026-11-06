import type * as WorkItemDetailsTestLookup from './work-item-details-test-lookup'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RateLimitGuardResult =
  | { blocked: false }
  | { blocked: true; remaining: number; limit: number; resetAt: number }

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getEnterpriseGitHubRepoSlugMock,
  getWorkItemMock,
  getWorkItemByOwnerRepoMock,
  getPRChecksMock,
  getPRCommentsMock,
  repositoryRateLimitGuardMock,
  noteRepositoryRateLimitSpendMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getEnterpriseGitHubRepoSlugMock: vi.fn(),
  getWorkItemMock: vi.fn(),
  getWorkItemByOwnerRepoMock: vi.fn(),
  getPRChecksMock: vi.fn(),
  getPRCommentsMock: vi.fn(),
  repositoryRateLimitGuardMock: vi.fn<
    (
      repository: { host?: string } | null | undefined,
      bucket: 'core' | 'graphql' | 'search',
      options?: { cwd?: string; host?: string; wslDistro?: string }
    ) => RateLimitGuardResult
  >(() => ({ blocked: false })),
  noteRepositoryRateLimitSpendMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  getOwnerRepo: getOwnerRepoMock,
  getOwnerRepoForRemote: vi.fn(),
  ghRepoExecOptions: vi.fn((context: { connectionId?: string | null; repoPath: string }) =>
    context.connectionId ? {} : { cwd: context.repoPath }
  ),
  githubRepoContext: vi.fn((repoPath: string, connectionId?: string | null) => ({
    repoPath,
    connectionId: connectionId ?? null
  })),
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
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
  getEnterpriseGitHubRepoSlugForRemote: vi.fn().mockResolvedValue(null),
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

describe('getWorkItemDetails Enterprise host routing', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getEnterpriseGitHubRepoSlugMock.mockReset()
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue(null)
    getWorkItemMock.mockReset()
    getWorkItemByOwnerRepoMock.mockReset()
    getPRChecksMock.mockReset()
    getPRCommentsMock.mockReset()
    repositoryRateLimitGuardMock.mockReset()
    repositoryRateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRepositoryRateLimitSpendMock.mockReset()
  })

  it('surfaces a found SSH PR without any default-host gh call when the repository is unresolved', async () => {
    // A found PR without a resolved Enterprise host must not fall back to github.com.
    getWorkItemMock.mockResolvedValueOnce({
      id: 'pr:7',
      type: 'pr',
      number: 7,
      title: 'Unresolved Enterprise PR',
      state: 'open',
      url: 'https://github.acme-corp.com/team/orca/pull/7',
      labels: [],
      updatedAt: '2026-07-16T00:00:00Z',
      author: 'pr-author'
    })
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue(null)

    const details = await getWorkItemDetails('/remote/repo', 7, 'pr', 'ssh-1')

    expect(details?.item.id).toBe('pr:7')
    expect(getWorkItemByOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
