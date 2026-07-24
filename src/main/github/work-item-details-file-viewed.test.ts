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
  repositoryRateLimitGuardMock,
  noteRepositoryRateLimitSpendMock,
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
  repositoryRateLimitGuardMock: vi.fn<
    (
      repository: { host?: string } | null | undefined,
      bucket: string,
      options?: { cwd?: string; host?: string }
    ) => RateLimitGuardResult
  >(() => ({ blocked: false })),
  noteRepositoryRateLimitSpendMock:
    vi.fn<
      (
        repository: { host?: string } | null | undefined,
        bucket: string,
        cost?: number,
        options?: { cwd?: string; host?: string }
      ) => void
    >(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  getOwnerRepoForRemote: getOwnerRepoMock,
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
  getWorkItemByOwnerRepo: vi.fn(),
  getPRChecks: getPRChecksMock,
  getPRComments: getPRCommentsMock
}))

vi.mock('./rate-limit', () => ({
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock,
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
    repositoryRateLimitGuardMock.mockReset()
    repositoryRateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRepositoryRateLimitSpendMock.mockReset()
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
    expect(getPRChecksMock).toHaveBeenCalledWith(
      '/repo-root',
      42,
      'head-sha',
      { owner: 'stablyai', repo: 'orca', host: 'github.com' },
      undefined,
      undefined
    )
    expect(repositoryRateLimitGuardMock.mock.calls.length).toBeGreaterThan(0)
    expect(
      repositoryRateLimitGuardMock.mock.calls.every(([, bucket, options]) =>
        bucket === 'graphql'
          ? options?.cwd === '/repo-root' && options?.host === 'github.com'
          : true
      )
    ).toBe(true)
    expect(noteRepositoryRateLimitSpendMock.mock.calls.length).toBeGreaterThan(0)
    expect(
      noteRepositoryRateLimitSpendMock.mock.calls.every(([, bucket, , options]) =>
        bucket === 'graphql'
          ? options?.cwd === '/repo-root' && options?.host === 'github.com'
          : true
      )
    ).toBe(true)
  })

  it('keeps PR details loadable when checks lookup fails', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
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
    getPRChecksMock.mockRejectedValue(
      Object.assign(new Error('Command failed: gh pr checks 42'), {
        stderr: "no checks reported on the 'codex/keybindings-toml' branch\n",
        stdout: ''
      })
    )
    ghExecFileAsyncMock.mockImplementation((args: string[]) => {
      const query = args.find((arg) => arg.startsWith('query=')) ?? ''
      if (query.includes('viewerViewedState')) {
        return Promise.resolve({
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  id: 'PR_kwDO123',
                  files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
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
        return Promise.resolve({ stdout: '[]' })
      }
      return Promise.reject(new Error(`unexpected gh call: ${args.join(' ')}`))
    })

    const details = await getWorkItemDetails('/repo-root', 42, 'pr')

    expect(details?.body).toBe('PR body')
    expect(details?.headSha).toBe('head-sha')
    expect(details?.checks).toEqual([])
    expect(consoleWarnSpy).toHaveBeenCalledOnce()
    consoleWarnSpy.mockRestore()
  })
})
