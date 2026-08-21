import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  acquireMock,
  releaseMock,
  ghExecFileAsyncMock,
  getWorkItemMock,
  getPRCommentsMock,
  getPRChecksMock
} = vi.hoisted(() => ({
  acquireMock: vi.fn<() => Promise<void>>(),
  releaseMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  getWorkItemMock: vi.fn(),
  getPRCommentsMock: vi.fn(),
  getPRChecksMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  acquire: acquireMock,
  release: releaseMock,
  ghExecFileAsync: ghExecFileAsyncMock,
  ghRepoExecOptions: (context: { repoPath: string }) => ({ cwd: context.repoPath }),
  githubRepoContext: (repoPath: string, connectionId?: string | null) => ({
    repoPath,
    connectionId: connectionId ?? null
  })
}))

vi.mock('./client', () => ({
  getWorkItem: getWorkItemMock,
  getPRComments: getPRCommentsMock,
  getPRChecks: getPRChecksMock
}))

vi.mock('./github-api-repository', () => ({
  getIssueGitHubApiRepository: vi.fn(),
  getOriginGitHubApiRepository: vi.fn(),
  githubHostExecOptions: (repository?: { host?: string } | null) =>
    repository?.host ? { host: repository.host } : {},
  // Why: getWorkItemDetails awaits resolveGitHubRepoExecution and reads .ownerRepo.
  resolveGitHubRepoExecution: vi.fn(
    async (
      _repoPath: string,
      repository?: { owner: string; repo: string; host?: string } | null
    ) => ({
      ownerRepo: repository ?? { owner: 'acme', repo: 'widgets', host: 'github.com' },
      ghOptions: {
        cwd: '/repo',
        host: repository?.host ?? 'github.com'
      }
    })
  )
}))

vi.mock('./rate-limit', () => ({
  repositoryRateLimitGuard: vi.fn(() => ({ blocked: false })),
  noteRepositoryRateLimitSpend: vi.fn()
}))

import { getWorkItemDetails } from './work-item-details'

describe('getWorkItemDetails concurrency', () => {
  beforeEach(() => {
    let running = 0
    const queue: (() => void)[] = []
    acquireMock.mockReset()
    acquireMock.mockImplementation(() => {
      if (running < 4) {
        running += 1
        return Promise.resolve()
      }
      return new Promise((resolve) =>
        queue.push(() => {
          running += 1
          resolve()
        })
      )
    })
    releaseMock.mockReset()
    releaseMock.mockImplementation(() => {
      running -= 1
      queue.shift()?.()
    })

    getWorkItemMock.mockReset()
    getWorkItemMock.mockImplementation(async (_repoPath: string, number: number) => ({
      id: `pr:${number}`,
      type: 'pr',
      number,
      title: `PR ${number}`,
      state: 'open',
      url: `https://github.com/acme/widgets/pull/${number}`,
      labels: [],
      updatedAt: '2026-07-16T00:00:00Z',
      author: null,
      prRepo: { owner: 'acme', repo: 'widgets', host: 'github.com' }
    }))

    const withNestedPermit = async <T>(value: T): Promise<T> => {
      await acquireMock()
      try {
        return value
      } finally {
        releaseMock()
      }
    }
    getPRCommentsMock.mockReset()
    getPRCommentsMock.mockImplementation(() => withNestedPermit([]))
    getPRChecksMock.mockReset()
    getPRChecksMock.mockImplementation(() => withNestedPermit([]))

    ghExecFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const query = args.find((arg) => arg.startsWith('query=')) ?? ''
      if (query.includes('viewerViewedState')) {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  id: 'PR_id',
                  files: { pageInfo: { hasNextPage: false }, nodes: [] }
                }
              }
            }
          })
        }
      }
      if (query.includes('participants')) {
        return {
          stdout: JSON.stringify({
            data: { repository: { pullRequest: { participants: { nodes: [] } } } }
          })
        }
      }
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
      if (endpoint.includes('/files?')) {
        return { stdout: '[]' }
      }
      if (/\/pulls\/\d+$/.test(endpoint)) {
        return {
          stdout: JSON.stringify({ body: 'body', head: { sha: 'head' }, base: { sha: 'base' } })
        }
      }
      return { stdout: JSON.stringify({ data: {} }) }
    })
  })

  it('does not deadlock four concurrent PR loads on nested client permits', async () => {
    const details = await Promise.all(
      [1, 2, 3, 4].map((number) => getWorkItemDetails('/repo', number, 'pr'))
    )

    expect(details.map((detail) => detail?.item.number)).toEqual([1, 2, 3, 4])
    expect(acquireMock.mock.calls.length).toBeGreaterThan(4)
    expect(releaseMock).toHaveBeenCalledTimes(acquireMock.mock.calls.length)
  })
})
