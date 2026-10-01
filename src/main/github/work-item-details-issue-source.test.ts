import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  getWorkItemMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getOwnerRepoForRemoteMock: vi.fn(),
  getWorkItemMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  getOwnerRepo: getOwnerRepoMock,
  getOwnerRepoForRemote: getOwnerRepoForRemoteMock,
  ghRepoExecOptions: vi.fn((context) => ({ cwd: context.repoPath })),
  githubRepoContext: vi.fn((repoPath, connectionId, localGitOptions) => ({
    repoPath,
    connectionId: connectionId ?? null,
    ...localGitOptions
  })),
  acquire: acquireMock,
  release: releaseMock
}))

vi.mock('./client', () => ({
  getWorkItem: getWorkItemMock,
  getWorkItemByOwnerRepo: vi.fn(),
  getPRChecks: vi.fn(),
  getPRComments: vi.fn()
}))

vi.mock('./github-enterprise-repository', () => ({
  getEnterpriseGitHubRepoSlug: vi.fn().mockResolvedValue(null),
  getEnterpriseGitHubRepoSlugForRemote: vi.fn().mockResolvedValue(null),
  isGitHubHostAuthenticated: vi.fn().mockResolvedValue(true)
}))

vi.mock('./rate-limit', () => ({
  repositoryRateLimitGuard: vi.fn(() => ({ blocked: false })),
  noteRepositoryRateLimitSpend: vi.fn()
}))

vi.mock('../git/remote-name-listing', () => ({
  shouldProbeGitRemote: vi.fn().mockResolvedValue(true)
}))

import { getWorkItemDetails } from './work-item-details'
import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository'

const REMOTES: Record<string, { owner: string; repo: string }> = {
  origin: { owner: 'fork-owner', repo: 'widgets' },
  upstream: { owner: 'upstream-owner', repo: 'widgets' }
}

function graphQLIssueResponse(assignee: string): { stdout: string } {
  return {
    stdout: JSON.stringify({
      data: {
        repository: {
          issue: {
            body: `${assignee} body`,
            assignees: { nodes: [{ login: assignee }] },
            participants: { nodes: [] },
            comments: { nodes: [] }
          }
        }
      }
    })
  }
}

function graphQLOwnerArg(): string | undefined {
  const args: string[] = ghExecFileAsyncMock.mock.calls[0][0]
  return args.find((arg) => arg.startsWith('owner='))
}

describe('getWorkItemDetails issue source', () => {
  beforeEach(() => {
    _resetOriginGitHubApiRepositoryCache()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getOwnerRepoMock.mockResolvedValue(REMOTES.origin)
    getOwnerRepoForRemoteMock.mockReset()
    getOwnerRepoForRemoteMock.mockImplementation(
      async (_repoPath: string, remoteName: string) => REMOTES[remoteName] ?? null
    )
    getWorkItemMock.mockReset()
    getWorkItemMock.mockResolvedValue({
      id: 'issue:5',
      type: 'issue',
      number: 5,
      title: 'Origin issue',
      state: 'open',
      url: 'https://github.com/fork-owner/widgets/issues/5',
      labels: [],
      updatedAt: '2026-04-01T00:00:00Z',
      author: 'fork-author'
    })
    acquireMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    releaseMock.mockReset()
  })

  it('reads body, assignees and comments from origin when origin is selected', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(graphQLIssueResponse('fork-assignee'))
      .mockResolvedValueOnce({ stdout: '' })

    const details = await getWorkItemDetails('/repo-root', 5, 'issue', null, {}, 'origin')

    expect(getWorkItemMock).toHaveBeenCalledWith('/repo-root', 5, 'issue', null, {}, 'origin')
    expect(graphQLOwnerArg()).toBe('owner=fork-owner')
    expect(ghExecFileAsyncMock.mock.calls[1][0]).toContain(
      'repos/fork-owner/widgets/issues/5/timeline?per_page=100&page=1'
    )
    expect(details?.assignees).toEqual(['fork-assignee'])
  })

  it('keeps the upstream-first default when no preference is set', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(graphQLIssueResponse('upstream-assignee'))
      .mockResolvedValueOnce({ stdout: '' })

    const details = await getWorkItemDetails('/repo-root', 5, 'issue', null, {})

    expect(graphQLOwnerArg()).toBe('owner=upstream-owner')
    expect(details?.assignees).toEqual(['upstream-assignee'])
  })
})
