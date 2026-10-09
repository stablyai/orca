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
import { createRepoHandlerHarness, resetLocalRepoMocks } from './repos-remote-test-harness'

const { handleMock, mockStore } = reposMocks
const relinked = { id: 'repo-1', path: '/new/app', displayName: 'app', badgeColor: '#000' }

describe('repos:update path relink', () => {
  const { handlers, mockWindow, captureHandlers } = createRepoHandlerHarness()
  const runtime = {
    relinkRepo: vi.fn(),
    listRepoPathStatuses: vi.fn()
  }

  beforeEach(() => {
    captureHandlers(handleMock)
    resetLocalRepoMocks(reposMocks)
    runtime.relinkRepo.mockReset()
    runtime.listRepoPathStatuses.mockReset()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test only touch the stubbed window, store and runtime members.
    registerRepoHandlers(mockWindow as never, mockStore as never, runtime as never)
  })

  it('routes a path to the host-validated relink and skips the settings write', async () => {
    runtime.relinkRepo.mockResolvedValue({ repo: relinked })
    const result = await handlers.get('repos:update')!(null, {
      repoId: 'repo-1',
      hostId: 'ssh:box',
      forcePath: true,
      updates: { path: '/new/app' }
    })
    expect(runtime.relinkRepo).toHaveBeenCalledWith('repo-1', '/new/app', {
      force: true,
      hostId: 'ssh:box'
    })
    expect(mockStore.updateRepo).not.toHaveBeenCalled()
    expect(result).toBe(relinked)
  })

  it('rejects with the coded refusal and never writes settings', async () => {
    runtime.relinkRepo.mockRejectedValue(new Error('repo_relink_path_not_found: gone'))
    await expect(
      handlers.get('repos:update')!(null, {
        repoId: 'repo-1',
        updates: { path: '/gone', displayName: 'renamed' }
      })
    ).rejects.toThrow('repo_relink_path_not_found')
    expect(mockStore.updateRepo).not.toHaveBeenCalled()
  })

  it('answers settings-only updates synchronously, as before', () => {
    mockStore.updateRepo.mockReturnValue(relinked)
    const result = handlers.get('repos:update')!(null, {
      repoId: 'repo-1',
      updates: { displayName: 'renamed' }
    })
    expect(result).toBe(relinked)
    expect(runtime.relinkRepo).not.toHaveBeenCalled()
  })

  it('exposes host path statuses', async () => {
    runtime.listRepoPathStatuses.mockResolvedValue([])
    await handlers.get('repos:getPathStatuses')!(null, { force: true })
    expect(runtime.listRepoPathStatuses).toHaveBeenCalledWith({ force: true })
  })
})
