import type * as GithubRepositoryIdentityModule from '../repositories/github-repository-identity'
import type * as WorkItemDetailsTestLookup from './work-item-details-test-lookup'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RateLimitGuardResult =
  | { blocked: false }
  | { blocked: true; remaining: number; limit: number; resetAt: number }

const {
  ghExecFileAsyncMock,
  getEnterpriseGitHubRepoSlugMock,
  getOwnerRepoMock,
  getWorkItemMock,
  getPRChecksMock,
  getPRCommentsMock,
  noteRepositoryRateLimitSpendMock,
  repositoryRateLimitGuardMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getEnterpriseGitHubRepoSlugMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getWorkItemMock: vi.fn(),
  getPRChecksMock: vi.fn(),
  getPRCommentsMock: vi.fn(),
  noteRepositoryRateLimitSpendMock:
    vi.fn<
      (
        repository: { host?: string } | null | undefined,
        bucket: string,
        cost?: number,
        options?: { cwd?: string; host?: string }
      ) => void
    >(),
  repositoryRateLimitGuardMock: vi.fn<
    (
      repository: { host?: string } | null | undefined,
      bucket: string,
      options?: { cwd?: string; host?: string }
    ) => RateLimitGuardResult
  >(() => ({ blocked: false }))
}))

vi.mock('../../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))

vi.mock('../repositories/github-repository-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubRepositoryIdentityModule>()),
  getOwnerRepoForRemote: getOwnerRepoMock,
  ghRepoExecOptions: vi.fn((context) => ({ cwd: context.repoPath })),
  githubRepoContext: vi.fn((repoPath, connectionId, localGitOptions) => ({
    repoPath,
    connectionId: connectionId ?? null,
    ...localGitOptions
  }))
}))

vi.mock('../repositories/github-owner-repo-selection', () => ({
  getOwnerRepo: vi.fn()
}))

vi.mock('../execution/github-operation-slots', () => ({
  acquire: vi.fn(),
  release: vi.fn()
}))

vi.mock('../client/fetch/get-work-item', async () => ({
  getWorkItem: getWorkItemMock,
  getWorkItemWithRepository: (
    await vi.importActual<typeof WorkItemDetailsTestLookup>('./work-item-details-test-lookup')
  ).makeWorkItemDetailsLookupMock(getWorkItemMock),
  getWorkItemByOwnerRepo: vi.fn()
}))

vi.mock('../client/check/get-pr-checks', async () => ({
  getPRChecks: getPRChecksMock
}))

vi.mock('../client/fetch/get-pr-comments', async () => ({
  getPRComments: getPRCommentsMock
}))

vi.mock('../repositories/github-enterprise-repository', () => ({
  getEnterpriseGitHubRepoSlug: getEnterpriseGitHubRepoSlugMock,
  isGitHubHostAuthenticated: vi.fn().mockResolvedValue(true)
}))

vi.mock('../api/rate-limit', () => ({
  rateLimitGuard: vi.fn(() => ({ blocked: false })),
  noteRateLimitSpend: vi.fn(),
  repositoryRateLimitGuard: repositoryRateLimitGuardMock,
  noteRepositoryRateLimitSpend: noteRepositoryRateLimitSpendMock
}))
import { getWorkItemDetails } from './work-item-details'

import { _resetOriginGitHubApiRepositoryCache } from '../repositories/github-api-repository-remote-probe'

beforeEach(() => {
  _resetOriginGitHubApiRepositoryCache()
})

function pullRequestItem(number: number, title: string): Record<string, unknown> {
  return {
    id: `pr:${number}`,
    type: 'pr',
    number,
    title,
    state: 'open',
    url: `https://github.com/acme/widgets/pull/${number}`,
    labels: [],
    updatedAt: '2026-07-16T00:00:00Z',
    author: 'pr-author'
  }
}

function auxiliaryPRResponse(args: string[]): { stdout: string } {
  const query = args.find((arg) => arg.startsWith('query=')) ?? ''
  if (query.includes('viewerViewedState')) {
    return {
      stdout: JSON.stringify({
        data: {
          repository: {
            viewedPullRequest: {
              id: 'PR_file_list',
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
}

describe('getWorkItemDetails PR file listing', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    getEnterpriseGitHubRepoSlugMock.mockReset()
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue(null)
    getWorkItemMock.mockReset()
    getPRChecksMock.mockReset()
    getPRChecksMock.mockResolvedValue([])
    getPRCommentsMock.mockReset()
    getPRCommentsMock.mockResolvedValue([])
    noteRepositoryRateLimitSpendMock.mockReset()
    repositoryRateLimitGuardMock.mockReset()
    repositoryRateLimitGuardMock.mockReturnValue({ blocked: false })
  })

  it('loads files beyond the first 100-result REST page', async () => {
    getWorkItemMock.mockResolvedValueOnce(pullRequestItem(108, 'Large PR'))
    const restFile = (index: number) => ({
      filename: `src/file-${index}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: '@@ -1 +1 @@'
    })
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
      if (endpoint === 'repos/acme/widgets/pulls/108') {
        return { stdout: JSON.stringify({ head: { sha: 'head' }, base: { sha: 'base' } }) }
      }
      if (endpoint === 'repos/acme/widgets/pulls/108/files?per_page=100') {
        return {
          stdout: JSON.stringify(Array.from({ length: 100 }, (_, index) => restFile(index)))
        }
      }
      if (endpoint === 'repos/acme/widgets/pulls/108/files?per_page=100&page=2') {
        return { stdout: JSON.stringify([restFile(100)]) }
      }
      return auxiliaryPRResponse(args)
    })

    const details = await getWorkItemDetails('/repo-root', 108, 'pr')

    expect(details?.files).toHaveLength(101)
    expect(details?.files?.at(-1)?.path).toBe('src/file-100.ts')
    const fileEndpoints = ghExecFileAsyncMock.mock.calls
      .map(([args]) => (args as string[]).find((arg) => arg.includes('/files?')))
      .filter(Boolean)
    expect(fileEndpoints).toEqual([
      'repos/acme/widgets/pulls/108/files?per_page=100',
      'repos/acme/widgets/pulls/108/files?per_page=100&page=2'
    ])
    expect(
      noteRepositoryRateLimitSpendMock.mock.calls.filter(([, bucket]) => bucket === 'core')
    ).toHaveLength(3)
    expect(
      repositoryRateLimitGuardMock.mock.calls.filter(([, bucket]) => bucket === 'core')
    ).toHaveLength(3)
  })

  it('does not run bare PR detail commands when local host resolution fails', async () => {
    getWorkItemMock.mockResolvedValueOnce({
      ...pullRequestItem(9, 'Unresolved PR'),
      prRepo: { owner: 'team', repo: 'orca' }
    })
    getOwnerRepoMock.mockResolvedValue(null)

    const details = await getWorkItemDetails('/repo-root', 9, 'pr')

    expect(details).toMatchObject({ body: '', comments: [], checks: [], filesUnavailable: true })
    expect(getPRCommentsMock).not.toHaveBeenCalled()
    expect(getPRChecksMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
