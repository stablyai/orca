import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock, acquireMock, releaseMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  execFileAsync: vi.fn(),
  ghExecFileAsync: ghExecFileAsyncMock,
  gitExecFileAsync: vi.fn(),
  getOwnerRepo: vi.fn(),
  getIssueOwnerRepo: vi.fn(),
  getOwnerRepoForRemote: vi.fn(),
  resolveIssueSource: vi.fn(),
  ghRepoExecOptions: vi.fn((context) => (context.connectionId ? {} : { cwd: context.repoPath })),
  githubRepoContext: vi.fn((repoPath, connectionId) => ({
    repoPath,
    connectionId: connectionId ?? null
  })),
  classifyGhError: vi.fn(),
  classifyListIssuesError: vi.fn(),
  acquire: acquireMock,
  release: releaseMock,
  _resetOwnerRepoCache: vi.fn()
}))

import { setPRFileViewed } from './client'

describe('setPRFileViewed', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
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
    expect(ghExecFileAsyncMock.mock.calls[0][1]).toEqual({ cwd: '/repo-root' })
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
})
