import type * as GithubRepositoryIdentityModule from '../../repositories/github-repository-identity'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock, getOwnerRepoMock, rateLimitGuardMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  rateLimitGuardMock: vi.fn(() => ({ blocked: false }))
}))

vi.mock('../../execution/github-legacy-command', () => ({
  execFileAsync: vi.fn()
}))

vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))

vi.mock('../../repositories/github-repository-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubRepositoryIdentityModule>()),
  githubRepoContext: (repoPath: string, connectionId?: string | null) => ({
    repoPath,
    connectionId: connectionId ?? null
  }),
  ghRepoExecOptions: (context: { repoPath: string }) => ({ cwd: context.repoPath }),
  getOwnerRepoForRemote: (
    repoPath: string,
    remoteName: string,
    connectionId?: string | null,
    localGitOptions?: unknown
  ) =>
    remoteName === 'origin'
      ? getOwnerRepoMock(repoPath, connectionId, localGitOptions)
      : Promise.resolve(null),
  _resetOwnerRepoCache: vi.fn()
}))

vi.mock('../../repositories/github-owner-repo-selection', () => ({
  getOwnerRepo: getOwnerRepoMock,
  resolveIssueSource: vi.fn()
}))

vi.mock('../../../git/command-runner/process-capture/exec-error', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  extractExecError: vi.fn((err: unknown) => ({ stderr: String(err), stdout: '' }))
}))

vi.mock('../../execution/github-operation-slots', () => ({
  acquire: vi.fn(),
  release: vi.fn()
}))

vi.mock('../../api/gh-error-classification', () => ({
  classifyGhError: (stderr: string) => ({ type: 'unknown', message: stderr }),
  classifyListIssuesError: (stderr: string) => ({ type: 'unknown', message: stderr })
}))

vi.mock('../../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: vi.fn()
}))

vi.mock('../../api/rate-limit', () => ({
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: vi.fn(),
  getRateLimit: vi.fn(async () => ({ ok: false, error: 'not probed in tests' })),
  repositoryRateLimitGuard: vi.fn(() => ({ blocked: false })),
  noteRepositoryRateLimitSpend: vi.fn(),
  spendsSharedGitHubComQuota: vi.fn(() => true)
}))

import { getWorkItem } from './get-work-item'
import { _resetMergeQueueCacheForTests } from '../detect/repository-merge-metadata-cache'
import { _resetOwnerRepoCache } from '../../repositories/github-repository-identity'
import { _resetOriginGitHubApiRepositoryCache } from '../../repositories/github-api-repository-remote-probe'

// Metadata and complete checks are independent provider responses.
function mockPullRequestDetail(payload: Record<string, unknown>): void {
  const head = 'a'.repeat(40)
  ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      return { stdout: JSON.stringify({ ...payload, headRefOid: head }) }
    }
    if (args.includes('graphql') && args.some((arg) => arg.includes('statusCheckRollup'))) {
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                number: payload.number,
                headRefOid: head,
                commits: {
                  nodes: [
                    {
                      commit: {
                        oid: head,
                        statusCheckRollup: {
                          contexts: {
                            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these test payloads contain object rollup rows only.
                            nodes: (payload.statusCheckRollup as Record<string, unknown>[]).map(
                              (raw) => ({
                                ...raw,
                                __typename:
                                  raw.__typename ?? (raw.state ? 'StatusContext' : 'CheckRun'),
                                ...(!raw.state ? { checkSuite: { databaseId: 7 } } : {})
                              })
                            ),
                            pageInfo: { hasNextPage: false, endCursor: null }
                          }
                        },
                        checkSuites: {
                          nodes: [],
                          pageInfo: { hasNextPage: false, endCursor: null }
                        }
                      }
                    }
                  ]
                }
              }
            }
          }
        })
      }
    }
    throw new Error('unexpected gh call')
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
        // StatusContext supplies state instead of CheckRun's status/conclusion.
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
      cancelled: 0,
      pending: 0,
      neutral: 1
    })
  })
})
