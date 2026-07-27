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

vi.mock('./gh-utils', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  getOwnerRepoForRemote: getOwnerRepoMock,
  getIssueOwnerRepo: vi.fn(),
  ghRepoExecOptions: vi.fn((context) => ({ cwd: context.repoPath })),
  githubRepoContext: vi.fn((repoPath, connectionId, localGitOptions) => ({
    repoPath,
    connectionId: connectionId ?? null,
    ...localGitOptions
  })),
  acquire: vi.fn(),
  release: vi.fn()
}))

vi.mock('./client', () => ({
  getWorkItem: getWorkItemMock,
  getWorkItemByOwnerRepo: vi.fn(),
  getPRChecks: getPRChecksMock,
  getPRComments: getPRCommentsMock
}))

vi.mock('./github-enterprise-repository', () => ({
  getEnterpriseGitHubRepoSlug: getEnterpriseGitHubRepoSlugMock,
  isGitHubHostAuthenticated: vi.fn().mockResolvedValue(true)
}))

vi.mock('./rate-limit', () => ({
  rateLimitGuard: vi.fn(() => ({ blocked: false })),
  noteRateLimitSpend: vi.fn(),
  repositoryRateLimitGuard: repositoryRateLimitGuardMock,
  noteRepositoryRateLimitSpend: noteRepositoryRateLimitSpendMock
}))

import { getPRFileContents, getWorkItemDetails } from './work-item-details'

import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository'

// The origin-repository cache is module-level state; reset it so slugs
// resolved by one test cannot leak into the next.
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
            pullRequest: {
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

  // Why: a rate-limited/auth-failed file fetch must not render as an empty PR;
  // the Files tab keys its retry state off details.filesUnavailable.
  it('flags filesUnavailable when the file fetch fails', async () => {
    getWorkItemMock.mockResolvedValueOnce(pullRequestItem(8305, 'Files fetch fails'))
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const target = args.at(-1)
      if (target === 'repos/acme/widgets/pulls/8305') {
        return {
          stdout: JSON.stringify({ head: { sha: 'head-sha' }, base: { sha: 'base-sha' } })
        }
      }
      if (target === 'repos/acme/widgets/pulls/8305/files?per_page=100') {
        throw new Error('gh: API rate limit exceeded (403)')
      }
      return auxiliaryPRResponse(args)
    })

    const details = await getWorkItemDetails('/repo-root', 8305, 'pr')

    expect(details?.filesUnavailable).toBe(true)
    expect(details?.files).toBeUndefined()
  })

  it('preserves an empty file list as an available result', async () => {
    getWorkItemMock.mockResolvedValueOnce(pullRequestItem(8306, 'Empty PR'))
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const target = args.at(-1)
      if (target === 'repos/acme/widgets/pulls/8306') {
        return {
          stdout: JSON.stringify({ head: { sha: 'head-sha' }, base: { sha: 'base-sha' } })
        }
      }
      if (target === 'repos/acme/widgets/pulls/8306/files?per_page=100') {
        return { stdout: '[]' }
      }
      return auxiliaryPRResponse(args)
    })

    const details = await getWorkItemDetails('/repo-root', 8306, 'pr')

    expect(details?.filesUnavailable).toBe(false)
    expect(details?.files).toEqual([])
  })

  it('backfills the Enterprise origin host before a host-less PR detail fan-out', async () => {
    const enterprise = { owner: 'team', repo: 'orca', host: 'github.acme-corp.com' }
    getWorkItemMock.mockResolvedValueOnce({
      ...pullRequestItem(8, 'Host-less Enterprise PR'),
      author: '',
      prRepo: { owner: 'team', repo: 'orca' }
    })
    getOwnerRepoMock.mockResolvedValue(null)
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue(enterprise)
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
      if (endpoint === 'repos/team/orca/pulls/8') {
        return { stdout: JSON.stringify({ body: 'Enterprise body' }) }
      }
      if (endpoint === 'repos/team/orca/pulls/8/files?per_page=100') {
        return { stdout: '[]' }
      }
      return auxiliaryPRResponse(args)
    })

    const details = await getWorkItemDetails('/remote/repo', 8, 'pr', 'ssh-1')

    expect(details?.item.prRepo).toEqual(enterprise)
    expect(getPRCommentsMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      { prRepo: enterprise },
      'ssh-1'
    )
    expect(getPRChecksMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      undefined,
      enterprise,
      undefined,
      'ssh-1'
    )
    expect(
      ghExecFileAsyncMock.mock.calls.every(([, options]) => options?.host === enterprise.host)
    ).toBe(true)
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

  it('uses the selected upstream GitHub Enterprise repo for both PR file sides', async () => {
    const prRepo = {
      owner: 'team',
      repo: 'orca',
      host: 'github.acme-corp.com'
    }
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
      if (endpoint === 'repos/team/orca/contents/src/path%23with%3Fchars.ts?ref=base-sha') {
        return { stdout: 'base content' }
      }
      if (endpoint === 'repos/team/orca/contents/src/path%23with%3Fchars.ts?ref=head-sha') {
        return { stdout: 'head content' }
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`)
    })

    const contents = await getPRFileContents({
      repoPath: '/repo-root',
      prRepo,
      prNumber: 7,
      path: 'src/path#with?chars.ts',
      status: 'modified',
      headSha: 'head-sha',
      baseSha: 'base-sha'
    })

    expect(contents).toMatchObject({
      original: 'base content',
      modified: 'head content',
      originalIsBinary: false,
      modifiedIsBinary: false
    })
    const apiCalls = ghExecFileAsyncMock.mock.calls.map(([args]) => args as string[])
    expect(apiCalls).toHaveLength(2)
    expect(apiCalls.every((args) => !args.includes('--hostname'))).toBe(true)
    expect(
      ghExecFileAsyncMock.mock.calls.every(
        ([, options]) => options?.host === 'github.acme-corp.com'
      )
    ).toBe(true)
    expect(
      repositoryRateLimitGuardMock.mock.calls.filter(([, bucket]) => bucket === 'core')
    ).toHaveLength(2)
    expect(
      noteRepositoryRateLimitSpendMock.mock.calls.filter(([, bucket]) => bucket === 'core')
    ).toHaveLength(2)
  })

  it('does not fetch raw PR file contents while the repository core budget is blocked', async () => {
    repositoryRateLimitGuardMock.mockReturnValue({
      blocked: true,
      remaining: 0,
      limit: 5000,
      resetAt: 1_800_000_000
    })

    await expect(
      getPRFileContents({
        repoPath: '/repo-root',
        prRepo: { owner: 'team', repo: 'orca', host: 'github.acme-corp.com' },
        prNumber: 7,
        path: 'src/file.ts',
        status: 'modified',
        headSha: 'head-sha',
        baseSha: 'base-sha'
      })
    ).resolves.toMatchObject({ original: '', modified: '' })

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(noteRepositoryRateLimitSpendMock).not.toHaveBeenCalled()
  })
})
