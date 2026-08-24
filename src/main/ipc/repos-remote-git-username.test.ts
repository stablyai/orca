import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../git/runner'
import type * as RepoModule from '../git/repo'

const { reposMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./repos-remote-test-harness')
  return { reposMocks: moduleMocks.createReposIpcMocks(), moduleMocks }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(reposMocks))
vi.mock('../git/repo', async (importOriginal) =>
  moduleMocks.gitRepoModuleMock(await importOriginal<typeof RepoModule>())
)
vi.mock('../git/runner', async (importOriginal) =>
  moduleMocks.gitRunnerModuleMock(reposMocks, await importOriginal<typeof GitRunner>())
)
vi.mock('../git/worktree', () => moduleMocks.gitWorktreeModuleMock(reposMocks))
vi.mock('./registered-worktree-roots-cache', () =>
  moduleMocks.registeredWorktreeRootsCacheModuleMock(reposMocks)
)
vi.mock('../worktree-root-preparation', () =>
  moduleMocks.worktreeRootPreparationModuleMock(reposMocks)
)
vi.mock('../providers/ssh-git-dispatch', () => moduleMocks.sshGitDispatchModuleMock(reposMocks))
vi.mock('../providers/ssh-filesystem-dispatch', () =>
  moduleMocks.sshFilesystemDispatchModuleMock(reposMocks)
)
vi.mock('./ssh', () => moduleMocks.sshModuleMock(reposMocks))
vi.mock('../ssh/ssh-target-registry', () => moduleMocks.sshModuleMock(reposMocks))

import { registerRepoHandlers } from './repos'
import { clearGitCapabilityStateForTests } from '../git/git-capability-state'
import { resetSshProviderAuthorities } from '../ssh/ssh-provider-authority'
import { createRepoHandlerHarness } from './repos-remote-test-harness'

const { handleMock, mockStore, mockGitProvider, prepareLocalWorktreeRootForRepoMock } = reposMocks

beforeEach(() => {
  clearGitCapabilityStateForTests()
  resetSshProviderAuthorities()
})

describe('repos:getGitUsername', () => {
  const { handlers, mockWindow, captureHandlers } = createRepoHandlerHarness()

  beforeEach(() => {
    captureHandlers(handleMock)
    mockStore.getRepo.mockReset()
    mockGitProvider.exec.mockReset()
    mockWindow.webContents.send.mockReset()
    prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)

    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  it('uses explicit SSH username config instead of remote author identity', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'git',
      connectionId: 'conn-1'
    })
    mockGitProvider.exec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'config' && args[1] === '--get') {
        const valueByKey: Record<string, string> = {
          'user.username': 'remote-login',
          'user.email': 'remote-user@example.com',
          'user.name': 'Remote User'
        }
        const value = valueByKey[args[2]]
        if (value) {
          return { stdout: `${value}\n`, stderr: '' }
        }
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const username = await handlers.get('repos:getGitUsername')!(null, { repoId: 'repo-ssh' })

    expect(username).toBe('remote-login')
    expect(mockGitProvider.exec).toHaveBeenCalledWith(
      ['config', '--get', 'github.user'],
      '/remote/repo'
    )
    expect(mockGitProvider.exec).toHaveBeenCalledWith(
      ['config', '--get', 'user.username'],
      '/remote/repo'
    )
    expect(mockGitProvider.exec).not.toHaveBeenCalledWith(
      ['config', '--get', 'user.email'],
      '/remote/repo'
    )
    expect(mockGitProvider.exec).not.toHaveBeenCalledWith(
      ['config', '--get', 'user.name'],
      '/remote/repo'
    )
  })
})
