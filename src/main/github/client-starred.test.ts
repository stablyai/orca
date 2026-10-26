import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))
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

import { __resetOrcaStarCheckForTests, checkOrcaStarred, starOrca } from './client/fetch/orca-star'
import { resetOriginRepositoryCache } from './client-test-harness'

const { execFileAsyncMock, ghExecFileAsyncMock, acquireMock, releaseMock } = clientMocks

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve()
  }
}

describe('checkOrcaStarred', () => {
  beforeEach(async () => {
    resetOriginRepositoryCache()
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    __resetOrcaStarCheckForTests()
  })

  it('returns true only for an included successful GitHub response', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'HTTP/2.0 204 No Content\r\n', stderr: '' })

    await expect(checkOrcaStarred()).resolves.toBe(true)

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', '--include', 'user/starred/stablyai/orca'],
      expect.objectContaining({ encoding: 'utf-8' })
    )
  })

  it('returns true for an HTTP 200 starred response', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'HTTP/2.0 200 OK\r\n', stderr: '' })

    await expect(checkOrcaStarred()).resolves.toBe(true)
  })

  it('returns false for GitHub 404 not starred responses', async () => {
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 404: Not Found'))

    await expect(checkOrcaStarred()).resolves.toBe(false)
  })

  it('returns null when gh exits successfully without response headers', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(checkOrcaStarred()).resolves.toBe(null)
  })

  it('never spawns gh directly, so the spawn carries a deadline and a tree kill', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'HTTP/2.0 204 No Content\r\n', stderr: '' })

    await checkOrcaStarred()

    expect(execFileAsyncMock).not.toHaveBeenCalled()
    const [, options] = ghExecFileAsyncMock.mock.calls[0]
    expect(typeof options.timeout).toBe('number')
    expect(options.timeout).toBeGreaterThan(0)
    expect(Number.isFinite(options.timeout)).toBe(true)
  })

  it('coalesces concurrent checks onto one gh child', async () => {
    let resolveGh: (value: { stdout: string; stderr: string }) => void = () => {}
    ghExecFileAsyncMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGh = resolve
      })
    )

    const first = checkOrcaStarred()
    const second = checkOrcaStarred()
    const third = checkOrcaStarred()
    await flushMicrotasks()

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(acquireMock).toHaveBeenCalledTimes(1)

    resolveGh({ stdout: 'HTTP/2.0 204 No Content\r\n', stderr: '' })
    await expect(Promise.all([first, second, third])).resolves.toEqual([true, true, true])
  })

  it('starts a fresh check once the previous one has settled', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'HTTP/2.0 404 Not Found\r\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'HTTP/2.0 204 No Content\r\n', stderr: '' })

    await checkOrcaStarred()
    await expect(checkOrcaStarred()).resolves.toBe(true)
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('releases its GitHub concurrency slot when gh fails or times out', async () => {
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('gh timed out.'))

    await expect(checkOrcaStarred()).resolves.toBe(null)

    expect(releaseMock).toHaveBeenCalledTimes(1)
    expect(acquireMock).toHaveBeenCalledTimes(1)
  })
})

describe('starOrca', () => {
  beforeEach(async () => {
    resetOriginRepositoryCache()
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    __resetOrcaStarCheckForTests()
  })

  it('stars through the bounded gh runner and releases its slot', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(starOrca()).resolves.toBe(true)

    expect(execFileAsyncMock).not.toHaveBeenCalled()
    const [args, options] = ghExecFileAsyncMock.mock.calls[0]
    expect(args).toEqual(['api', '-X', 'PUT', 'user/starred/stablyai/orca'])
    expect(options.timeout).toBeGreaterThan(0)
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  it('reports failure and still releases its slot when gh times out', async () => {
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('gh timed out.'))

    await expect(starOrca()).resolves.toBe(false)
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })
})
