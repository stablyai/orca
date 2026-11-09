import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubEnterpriseRepositoryModule from './github-enterprise-repository'

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
  extractExecError: vi.fn((err: unknown) => ({ stderr: String(err), stdout: '' })),
  acquire: vi.fn(),
  release: vi.fn(),
  _resetOwnerRepoCache: vi.fn()
}))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: vi.fn()
}))

vi.mock('./github-enterprise-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubEnterpriseRepositoryModule>()),
  isGitHubHostAuthenticated: vi.fn().mockResolvedValue(true)
}))

vi.mock('./rate-limit', () => ({
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: vi.fn(),
  repositoryRateLimitGuard: vi.fn(() => ({ blocked: false })),
  noteRepositoryRateLimitSpend: vi.fn(),
  spendsSharedGitHubComQuota: vi.fn(() => true)
}))

import { getPRCheckDetails } from './client/check/get-pr-check-details'
import { _resetOwnerRepoCache } from './gh-utils'

describe('getPRCheckDetails', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    _resetOwnerRepoCache()
  })

  it('aborts host work at the cumulative check-details deadline', async () => {
    vi.useFakeTimers()
    try {
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
      ghExecFileAsyncMock.mockImplementation(
        (_args: string[], options: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('aborted')
                error.name = 'AbortError'
                reject(error)
              },
              { once: true }
            )
          })
      )
      const request = getPRCheckDetails('/repo-root', { checkRunId: 88 })
      const rejection = expect(request).rejects.toThrow('Timed out loading check details.')

      await vi.advanceTimersByTimeAsync(25_000)

      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops waiting for shared repository resolution at the host deadline', async () => {
    vi.useFakeTimers()
    try {
      getOwnerRepoMock.mockImplementationOnce(() => new Promise(() => {}))
      const request = getPRCheckDetails('/repo-root', { checkRunId: 88 })
      const rejection = expect(request).rejects.toThrow('Timed out loading check details.')

      await vi.advanceTimersByTimeAsync(25_000)

      await rejection
      expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
