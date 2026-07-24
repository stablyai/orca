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

vi.mock('./client', () => ({
  getWorkItem: getWorkItemMock,
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

// The origin-repository cache is module-level state; reset it so slugs
// resolved by one test cannot leak into the next.
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

  it('uses the GitHub Enterprise host for SSH-backed issue work item details', async () => {
    const enterpriseRepository = {
      owner: 'team',
      repo: 'orca',
      host: 'github.acme-corp.com'
    }
    getWorkItemMock.mockResolvedValueOnce({
      id: 'issue:7',
      type: 'issue',
      number: 7,
      title: 'Enterprise issue',
      state: 'open',
      url: 'https://github.acme-corp.com/team/orca/issues/7',
      labels: [],
      updatedAt: '2026-07-16T00:00:00Z',
      author: 'issue-author'
    })
    getOwnerRepoMock.mockResolvedValue(null)
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue(enterpriseRepository)
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const query = args.find((arg) => arg.startsWith('query=')) ?? ''
      if (query.includes('comments(first: 100)')) {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: {
                  body: 'Enterprise issue body',
                  assignees: { nodes: [] },
                  participants: { nodes: [] },
                  comments: { nodes: [] }
                }
              }
            }
          })
        }
      }
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
      if (endpoint === 'repos/team/orca/issues/7/timeline?per_page=100&page=1') {
        return { stdout: '' }
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`)
    })

    const details = await getWorkItemDetails('/remote/repo', 7, 'issue', 'ssh-1')

    expect(details?.body).toBe('Enterprise issue body')
    expect(getWorkItemMock).toHaveBeenCalledWith('/remote/repo', 7, 'issue', 'ssh-1')
    expect(getWorkItemByOwnerRepoMock).not.toHaveBeenCalled()
    expect(getEnterpriseGitHubRepoSlugMock).toHaveBeenCalledTimes(1)
    expect(repositoryRateLimitGuardMock).toHaveBeenCalledWith(enterpriseRepository, 'graphql', {
      host: 'github.acme-corp.com'
    })
    expect(noteRepositoryRateLimitSpendMock).toHaveBeenCalled()
    expect(
      ghExecFileAsyncMock.mock.calls.every(
        ([, options]) => options?.host === 'github.acme-corp.com'
      )
    ).toBe(true)
  })

  it('does not query the default host when an SSH issue work item is not found', async () => {
    getWorkItemMock.mockResolvedValue(null)

    await expect(getWorkItemDetails('/remote/repo', 7, 'issue', 'ssh-1')).resolves.toBeNull()

    expect(getWorkItemMock).toHaveBeenCalledWith('/remote/repo', 7, 'issue', 'ssh-1')
    expect(getWorkItemByOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('uses the GitHub Enterprise host for SSH-backed PR work item details', async () => {
    getWorkItemMock.mockResolvedValueOnce({
      id: 'pr:7',
      type: 'pr',
      number: 7,
      title: 'Enterprise PR files',
      state: 'open',
      url: 'https://github.acme-corp.com/team/orca/pull/7',
      labels: [],
      updatedAt: '2026-07-16T00:00:00Z',
      author: 'pr-author',
      prRepo: { owner: 'team', repo: 'orca', host: 'github.acme-corp.com' }
    })
    getPRCommentsMock.mockResolvedValue([])
    getPRChecksMock.mockResolvedValue([])
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
      if (endpoint === 'repos/team/orca/pulls/7') {
        return {
          stdout: JSON.stringify({
            body: 'Enterprise PR body',
            head: { sha: 'head-sha' },
            base: { sha: 'base-sha' }
          })
        }
      }
      if (endpoint === 'repos/team/orca/pulls/7/files?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              filename: 'src/enterprise.ts',
              status: 'modified',
              additions: 2,
              deletions: 1,
              changes: 3,
              patch: '@@ -1 +1 @@'
            }
          ])
        }
      }
      const query = args.find((arg) => arg.startsWith('query=')) ?? ''
      if (query.includes('viewerViewedState')) {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  id: 'PR_enterprise',
                  files: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ path: 'src/enterprise.ts', viewerViewedState: 'VIEWED' }]
                  }
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
      throw new Error(`unexpected gh call: ${args.join(' ')}`)
    })

    const details = await getWorkItemDetails('/remote/repo', 7, 'pr', 'ssh-1')

    expect(details?.body).toBe('Enterprise PR body')
    expect(details?.headSha).toBe('head-sha')
    expect(details?.baseSha).toBe('base-sha')
    expect(details?.filesUnavailable).toBe(false)
    expect(details?.files).toEqual([
      {
        path: 'src/enterprise.ts',
        oldPath: undefined,
        status: 'modified',
        additions: 2,
        deletions: 1,
        isBinary: false,
        reviewCommentLineNumbers: [],
        viewerViewedState: 'VIEWED'
      }
    ])
    expect(getWorkItemMock).toHaveBeenCalledWith('/remote/repo', 7, 'pr', 'ssh-1')
    expect(getWorkItemByOwnerRepoMock).not.toHaveBeenCalled()
    expect(getPRCommentsMock).toHaveBeenCalledWith(
      '/remote/repo',
      7,
      { prRepo: { owner: 'team', repo: 'orca', host: 'github.acme-corp.com' } },
      'ssh-1'
    )
    expect(getPRChecksMock).toHaveBeenCalledWith(
      '/remote/repo',
      7,
      'head-sha',
      { owner: 'team', repo: 'orca', host: 'github.acme-corp.com' },
      undefined,
      'ssh-1'
    )
    const apiCalls = ghExecFileAsyncMock.mock.calls
      .map(([args]) => args as string[])
      .filter((args) => args[0] === 'api')
    expect(apiCalls.length).toBeGreaterThan(0)
    expect(apiCalls.every((args) => !args.includes('--hostname'))).toBe(true)
    expect(
      ghExecFileAsyncMock.mock.calls.every(
        ([, options]) => options?.host === 'github.acme-corp.com'
      )
    ).toBe(true)
  })

  it('does not query the default host when an SSH PR work item is not found', async () => {
    getWorkItemMock.mockResolvedValue(null)

    await expect(getWorkItemDetails('/remote/repo', 7, 'pr', 'ssh-1')).resolves.toBeNull()

    expect(getWorkItemMock).toHaveBeenCalledWith('/remote/repo', 7, 'pr', 'ssh-1')
    expect(getWorkItemByOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('surfaces a found SSH PR without any default-host gh call when the repository is unresolved', async () => {
    // Why: this is the regression under test — a *found* PR whose owner/repo
    // cannot be resolved to an Enterprise host must not silently fall back to
    // github.com. With no prRepo, origin resolution runs and returns null.
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

    // The item is still surfaced, but no host-qualified (or default-host) gh
    // request is made because the execution repository never resolved.
    expect(details?.item.id).toBe('pr:7')
    expect(getWorkItemByOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
