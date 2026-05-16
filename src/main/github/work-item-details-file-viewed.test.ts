import { beforeEach, describe, expect, it, vi } from 'vitest'

type RateLimitGuardResult =
  | { blocked: false }
  | { blocked: true; remaining: number; limit: number; resetAt: number }

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getIssueOwnerRepoMock,
  getWorkItemMock,
  getPRChecksMock,
  getPRCommentsMock,
  rateLimitGuardMock,
  noteRateLimitSpendMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  getWorkItemMock: vi.fn(),
  getPRChecksMock: vi.fn(),
  getPRCommentsMock: vi.fn(),
  rateLimitGuardMock: vi.fn<() => RateLimitGuardResult>(() => ({ blocked: false })),
  noteRateLimitSpendMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  getOwnerRepo: getOwnerRepoMock,
  getIssueOwnerRepo: getIssueOwnerRepoMock,
  ghRepoExecOptions: vi.fn((context) => (context.connectionId ? {} : { cwd: context.repoPath })),
  githubRepoContext: vi.fn((repoPath, connectionId) => ({
    repoPath,
    connectionId: connectionId ?? null
  })),
  acquire: acquireMock,
  release: releaseMock
}))

vi.mock('./client', () => ({
  getWorkItem: getWorkItemMock,
  getPRChecks: getPRChecksMock,
  getPRComments: getPRCommentsMock
}))

vi.mock('./rate-limit', () => ({
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock
}))

import { getWorkItemDetails } from './work-item-details'

describe('getWorkItemDetails PR file viewed state', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    getWorkItemMock.mockReset()
    getPRChecksMock.mockReset()
    getPRCommentsMock.mockReset()
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRateLimitSpendMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
  })

  it('merges GitHub viewer viewed state into PR files', async () => {
    getWorkItemMock.mockResolvedValueOnce({
      id: 'pr:42',
      type: 'pr',
      number: 42,
      title: 'Review files',
      state: 'open',
      url: 'https://github.com/stablyai/orca/pull/42',
      labels: [],
      updatedAt: '2026-04-01T00:00:00Z',
      author: null
    })
    getOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    getPRCommentsMock.mockResolvedValue([])
    getPRChecksMock.mockResolvedValue([])
    ghExecFileAsyncMock.mockImplementation((args: string[]) => {
      const query = args.find((arg) => arg.startsWith('query=')) ?? ''
      if (query.includes('viewerViewedState')) {
        return Promise.resolve({
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  id: 'PR_kwDO123',
                  files: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      { path: 'src/viewed.ts', viewerViewedState: 'VIEWED' },
                      { path: 'src/changed.ts', viewerViewedState: 'DISMISSED' }
                    ]
                  }
                }
              }
            }
          })
        })
      }
      if (query.includes('participants')) {
        return Promise.resolve({
          stdout: JSON.stringify({
            data: { repository: { pullRequest: { participants: { nodes: [] } } } }
          })
        })
      }
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
      if (endpoint === 'repos/stablyai/orca/pulls/42') {
        return Promise.resolve({
          stdout: JSON.stringify({
            body: 'PR body',
            head: { sha: 'head-sha' },
            base: { sha: 'base-sha' }
          })
        })
      }
      if (endpoint === 'repos/stablyai/orca/pulls/42/files?per_page=100') {
        return Promise.resolve({
          stdout: JSON.stringify([
            {
              filename: 'src/viewed.ts',
              status: 'modified',
              additions: 3,
              deletions: 1,
              changes: 4,
              patch: '@@'
            },
            {
              filename: 'src/changed.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
              changes: 1,
              patch: '@@'
            }
          ])
        })
      }
      return Promise.reject(new Error(`unexpected gh call: ${args.join(' ')}`))
    })

    const details = await getWorkItemDetails('/repo-root', 42, 'pr')

    expect(details?.pullRequestId).toBe('PR_kwDO123')
    expect(details?.headSha).toBe('head-sha')
    expect(details?.baseSha).toBe('base-sha')
    expect(details?.files?.map((file) => [file.path, file.viewerViewedState])).toEqual([
      ['src/viewed.ts', 'VIEWED'],
      ['src/changed.ts', 'DISMISSED']
    ])
    expect(getPRChecksMock).toHaveBeenCalledWith('/repo-root', 42, 'head-sha', undefined, undefined)
  })
})
