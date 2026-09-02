import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock, getOwnerRepoMock, rateLimitGuardMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  rateLimitGuardMock: vi.fn(() => ({ blocked: false }))
}))

vi.mock('./gh-utils', () => ({
  execFileAsync: vi.fn(),
  ghExecFileAsync: ghExecFileAsyncMock,
  githubRepoContext: (repoPath: string, connectionId?: string | null) => ({
    repoPath,
    connectionId: connectionId ?? null
  }),
  ghRepoExecOptions: (context: { repoPath: string }) => ({ cwd: context.repoPath }),
  getOwnerRepo: getOwnerRepoMock,
  getIssueOwnerRepo: vi.fn(),
  getOwnerRepoForRemote: (
    repoPath: string,
    remoteName: string,
    connectionId?: string | null,
    localGitOptions?: unknown
  ) =>
    remoteName === 'origin'
      ? getOwnerRepoMock(repoPath, connectionId, localGitOptions)
      : Promise.resolve(null),
  resolveIssueSource: vi.fn(),
  extractExecError: vi.fn((err: unknown) => ({ stderr: String(err), stdout: '' })),
  acquire: vi.fn(),
  release: vi.fn(),
  _resetOwnerRepoCache: vi.fn(),
  classifyGhError: (stderr: string) => ({ type: 'unknown', message: stderr }),
  classifyListIssuesError: (stderr: string) => ({ type: 'unknown', message: stderr })
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn()
}))

vi.mock('./rate-limit', () => ({
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: vi.fn(),
  getRateLimit: vi.fn(async () => ({ ok: false, error: 'not probed in tests' })),
  repositoryRateLimitGuard: vi.fn(() => ({ blocked: false })),
  noteRepositoryRateLimitSpend: vi.fn(),
  spendsSharedGitHubComQuota: vi.fn(() => true)
}))

import { getWorkItem, _resetMergeQueueCacheForTests, _resetOwnerRepoCache } from './client'
import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository'

// Why: only `pr view` is fixtured; the merge-metadata fan-out is best-effort and must not mask the summary.
function mockPullRequestDetail(payload: Record<string, unknown>): void {
  ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] !== 'pr' || args[1] !== 'view') {
      throw new Error('unexpected gh call')
    }
    return { stdout: JSON.stringify(payload) }
  })
}

describe('work item checksSummary', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    _resetOwnerRepoCache()
    _resetOriginGitHubApiRepositoryCache()
    _resetMergeQueueCacheForTests()
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
  })

  it('counts a skipped run as passing and reads a StatusContext state as its conclusion', async () => {
    mockPullRequestDetail({
      number: 42,
      title: 'Add feature',
      state: 'OPEN',
      url: 'https://github.com/acme/widgets/pull/42',
      updatedAt: '2026-04-01T00:00:00Z',
      statusCheckRollup: [
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
        // Why: StatusContext carries no status/conclusion — only `state`.
        { __typename: 'StatusContext', state: 'SUCCESS' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'NEUTRAL' }
      ]
    })

    const item = await getWorkItem('/repo-root', 42, 'pr', null, {}, 'origin')

    expect(item?.checksSummary).toEqual({
      state: 'success',
      total: 3,
      passed: 2,
      failed: 0,
      pending: 0,
      neutral: 1
    })
  })

  it('reports a still-running check as pending', async () => {
    mockPullRequestDetail({
      number: 43,
      title: 'Add feature',
      state: 'OPEN',
      url: 'https://github.com/acme/widgets/pull/43',
      updatedAt: '2026-04-01T00:00:00Z',
      statusCheckRollup: [
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }
      ]
    })

    const item = await getWorkItem('/repo-root', 43, 'pr', null, {}, 'origin')

    expect(item?.checksSummary).toEqual({
      state: 'pending',
      total: 2,
      passed: 1,
      failed: 0,
      pending: 1,
      neutral: 0
    })
  })

  it('fails the summary on a failing run and leaves an empty rollup with no state', async () => {
    mockPullRequestDetail({
      number: 44,
      title: 'Add feature',
      state: 'OPEN',
      url: 'https://github.com/acme/widgets/pull/44',
      updatedAt: '2026-04-01T00:00:00Z',
      statusCheckRollup: [
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }
      ]
    })
    await expect(getWorkItem('/repo-root', 44, 'pr', null, {}, 'origin')).resolves.toMatchObject({
      checksSummary: { state: 'failure', total: 2, passed: 1, failed: 1, pending: 0, neutral: 0 }
    })

    mockPullRequestDetail({
      number: 45,
      title: 'Add feature',
      state: 'OPEN',
      url: 'https://github.com/acme/widgets/pull/45',
      updatedAt: '2026-04-01T00:00:00Z',
      statusCheckRollup: []
    })
    await expect(getWorkItem('/repo-root', 45, 'pr', null, {}, 'origin')).resolves.toMatchObject({
      checksSummary: { state: 'none', total: 0, passed: 0, failed: 0, pending: 0, neutral: 0 }
    })
  })
})
