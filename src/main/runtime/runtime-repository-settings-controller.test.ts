import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { RuntimeRepositorySettingsController } from './runtime-repository-settings-controller'
import type { RuntimeStore } from './runtime-store-contract'

const repo = { id: 'repo-1', path: '/srv/repo', worktreeBaseRef: 'origin/dev' } as Repo

function makeController() {
  const updateRepo = vi.fn().mockReturnValue({ ...repo, worktreeBaseRef: undefined })
  const controller = new RuntimeRepositorySettingsController({
    getStore: () => ({ updateRepo }) as unknown as RuntimeStore,
    resolveRepo: async () => repo,
    forgetTerminalTopology: vi.fn(),
    invalidateResolvedWorktrees: vi.fn(),
    invalidateWorktreeScan: vi.fn(),
    notifyReposChanged: vi.fn()
  })
  return { controller, updateRepo }
}

describe('RuntimeRepositorySettingsController.update worktreeBaseRef', () => {
  it('turns the null wire sentinel into a store clear', async () => {
    const { controller, updateRepo } = makeController()

    await controller.update('repo-1', { worktreeBaseRef: null })

    expect(updateRepo).toHaveBeenCalledWith('repo-1', { worktreeBaseRef: undefined })
    expect(updateRepo.mock.calls[0]?.[1]).toHaveProperty('worktreeBaseRef')
  })

  it('leaves the pin alone when the field is absent or blank', async () => {
    const { controller, updateRepo } = makeController()

    await controller.update('repo-1', { worktreeBaseRef: undefined })

    expect(updateRepo.mock.calls[0]?.[1]).not.toHaveProperty('worktreeBaseRef')
  })

  it('writes a string pin', async () => {
    const { controller, updateRepo } = makeController()

    await controller.update('repo-1', { worktreeBaseRef: 'origin/main' })

    expect(updateRepo).toHaveBeenCalledWith('repo-1', { worktreeBaseRef: 'origin/main' })
  })
})
