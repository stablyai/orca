import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))
vi.mock('../providers/ssh-git-dispatch', () => moduleMocks.sshGitDispatchModuleMock(clientMocks))
vi.mock('./local-git-config-signature', () =>
  moduleMocks.localGitConfigSignatureModuleMock(clientMocks)
)
vi.mock('./github-enterprise-repository', async (importOriginal) =>
  moduleMocks.githubEnterpriseRepositoryModuleMock(
    await importOriginal<typeof GitHubEnterpriseRepositoryModule>()
  )
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(clientMocks))
vi.mock('./github-api-repository', async (importOriginal) =>
  moduleMocks.githubApiRepositoryModuleMock(
    clientMocks,
    await importOriginal<typeof GithubApiRepositoryModule>()
  )
)

import { checkOrcaStarred } from './client'
import { resetOriginRepositoryCache } from './client-test-harness'

const { execFileAsyncMock, acquireMock, releaseMock } = clientMocks

describe('checkOrcaStarred', () => {
  beforeEach(() => {
    resetOriginRepositoryCache()
    execFileAsyncMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
  })

  it('returns true only for an included successful GitHub response', async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: 'HTTP/2.0 204 No Content\r\n', stderr: '' })

    await expect(checkOrcaStarred()).resolves.toBe(true)

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'gh',
      ['api', '--include', 'user/starred/stablyai/orca'],
      { encoding: 'utf-8' }
    )
  })

  it('returns true for an HTTP 200 starred response', async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: 'HTTP/2.0 200 OK\r\n', stderr: '' })

    await expect(checkOrcaStarred()).resolves.toBe(true)
  })

  it('returns false for GitHub 404 not starred responses', async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 404: Not Found'))

    await expect(checkOrcaStarred()).resolves.toBe(false)
  })

  it('returns null when gh exits successfully without response headers', async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(checkOrcaStarred()).resolves.toBe(null)
  })
})
