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

import { updatePRState, _resetOwnerRepoCache } from './client'
import { resetOriginRepositoryCache } from './client-test-harness'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  ghRepoExecOptionsMock,
  githubRepoContextMock,
  acquireMock,
  releaseMock
} = clientMocks

describe('updatePRState', () => {
  beforeEach(() => {
    resetOriginRepositoryCache()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getOwnerRepoForRemoteMock.mockReset()
    // Why: updatePRState resolves origin through getOwnerRepoForRemote.
    getOwnerRepoForRemoteMock.mockImplementation(
      async (repoPath: string, remoteName: string, connectionId?: string | null, opts = {}) =>
        remoteName === 'origin' ? getOwnerRepoMock(repoPath, connectionId, opts) : null
    )
    ghRepoExecOptionsMock.mockClear()
    githubRepoContextMock.mockClear()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    _resetOwnerRepoCache()
  })

  it('reopens pull requests through the gh PR command', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(updatePRState('/repo-root', 3977, { state: 'open' })).resolves.toEqual({
      ok: true
    })

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['pr', 'reopen', '3977', '--repo', 'stablyai/orca'],
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(acquireMock).toHaveBeenCalledTimes(1)
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  it('closes pull requests through the gh PR command', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(updatePRState('/repo-root', 3977, { state: 'closed' })).resolves.toEqual({
      ok: true
    })

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['pr', 'close', '3977', '--repo', 'stablyai/orca'],
      { cwd: '/repo-root', host: 'github.com' }
    )
  })

  it('reopens SSH-backed pull requests without local cwd options', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(
      updatePRState('/remote/repo-root', 3977, { state: 'open' }, 'ssh-1')
    ).resolves.toEqual({
      ok: true
    })

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['pr', 'reopen', '3977', '--repo', 'stablyai/orca'],
      { host: 'github.com' }
    )
  })
})
