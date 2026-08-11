import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getEnterpriseGitHubRepoSlugMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getEnterpriseGitHubRepoSlugMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  execFileAsync: vi.fn(),
  ghExecFileAsync: ghExecFileAsyncMock,
  gitExecFileAsync: vi.fn(),
  getOwnerRepo: getOwnerRepoMock,
  getIssueOwnerRepo: vi.fn(),
  // Why: origin repository resolution calls getOwnerRepoForRemote, not getOwnerRepo.
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
  ghRepoExecOptions: vi.fn((context) =>
    context.connectionId
      ? {}
      : { cwd: context.repoPath, ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}) }
  ),
  githubRepoContext: vi.fn((repoPath, connectionId, localGitOptions) => ({
    repoPath,
    connectionId: connectionId ?? null,
    ...localGitOptions
  })),
  classifyGhError: vi.fn(),
  classifyListIssuesError: vi.fn(),
  acquire: acquireMock,
  release: releaseMock,
  _resetOwnerRepoCache: vi.fn()
}))

vi.mock('./github-enterprise-repository', () => ({
  getEnterpriseGitHubRepoSlug: getEnterpriseGitHubRepoSlugMock,
  isGitHubHostAuthenticated: vi.fn().mockResolvedValue(true)
}))

import { setPRFileViewed } from './client'

import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository'

// The origin-repository cache is module-level state; reset it so slugs
// resolved by one test cannot leak into the next.
beforeEach(() => {
  _resetOriginGitHubApiRepositoryCache()
})

describe('setPRFileViewed', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'orca' })
    getEnterpriseGitHubRepoSlugMock.mockReset()
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue(null)
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
  })

  it('uses GitHub GraphQL file-viewed mutations', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '{}' })

    await expect(
      setPRFileViewed({
        repoPath: '/repo-root',
        pullRequestId: 'PR_kwDO123',
        path: 'src/app.ts',
        viewed: true
      })
    ).resolves.toBe(true)

    const args = ghExecFileAsyncMock.mock.calls[0][0]
    expect(args[0]).toBe('api')
    expect(args[1]).toBe('graphql')
    expect(args.find((arg: string) => arg.startsWith('query='))).toContain('markFileAsViewed')
    expect(args).toContain('pullRequestId=PR_kwDO123')
    expect(args).toContain('path=src/app.ts')
    expect(ghExecFileAsyncMock.mock.calls[0][1]).toEqual({
      cwd: '/repo-root',
      host: 'github.com'
    })
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  it('uses GitHub GraphQL file-unviewed mutations', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '{}' })

    await expect(
      setPRFileViewed({
        repoPath: '/repo-root',
        pullRequestId: 'PR_kwDO123',
        path: 'src/app.ts',
        viewed: false
      })
    ).resolves.toBe(true)

    const args = ghExecFileAsyncMock.mock.calls[0][0]
    expect(args.find((arg: string) => arg.startsWith('query='))).toContain('unmarkFileAsViewed')
  })

  it('routes local WSL file-viewed mutations through the selected distro', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '{}' })

    await expect(
      setPRFileViewed({
        repoPath: '/repo-root',
        connectionId: null,
        localGitOptions: { wslDistro: 'Ubuntu' },
        pullRequestId: 'PR_kwDO123',
        path: 'src/app.ts',
        viewed: true
      })
    ).resolves.toBe(true)

    expect(ghExecFileAsyncMock.mock.calls[0][1]).toEqual({
      cwd: '/repo-root',
      host: 'github.com',
      wslDistro: 'Ubuntu'
    })
  })

  it('routes SSH-backed GitHub Enterprise file-viewed mutations to the Enterprise host', async () => {
    getOwnerRepoMock.mockResolvedValueOnce(null)
    getEnterpriseGitHubRepoSlugMock.mockResolvedValueOnce({
      owner: 'team',
      repo: 'orca',
      host: 'github.acme-corp.com'
    })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '{}' })

    await expect(
      setPRFileViewed({
        repoPath: '/remote/repo',
        connectionId: 'ssh-1',
        pullRequestId: 'PR_enterprise',
        path: 'src/enterprise.ts',
        viewed: true
      })
    ).resolves.toBe(true)

    // The runner injects --hostname at spawn time from options.host, so the
    // mocked call sees unqualified argv plus the Enterprise host in options.
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      expect.arrayContaining(['api', 'graphql', 'pullRequestId=PR_enterprise']),
      { host: 'github.acme-corp.com' }
    )
    const [args] = ghExecFileAsyncMock.mock.calls[0]
    expect(args).not.toContain('--hostname')
  })

  it('refuses an unresolved local file-viewed mutation', async () => {
    getOwnerRepoMock.mockResolvedValue(null)
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue(null)

    await expect(
      setPRFileViewed({
        repoPath: '/repo-root',
        prRepo: { owner: 'team', repo: 'orca' },
        pullRequestId: 'PR_unresolved',
        path: 'src/app.ts',
        viewed: true
      })
    ).resolves.toBe(false)

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
