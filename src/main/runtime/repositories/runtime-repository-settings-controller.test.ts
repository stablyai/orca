import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'
import { RuntimeRepositorySettingsController } from './runtime-repository-settings-controller'
import type { RuntimeStore } from '../construction/runtime-store-contract'

const repo: Repo = {
  id: 'repo-1',
  path: '/srv/repo',
  worktreeBaseRef: 'origin/dev',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}

function makeController() {
  const updateRepo = vi.fn().mockReturnValue({ ...repo, worktreeBaseRef: undefined })
  const controller = new RuntimeRepositorySettingsController({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this settings fixture only persists updates through updateRepo.
    getStore: () => ({ updateRepo }) as unknown as RuntimeStore,
    resolveRepo: async () => repo,
    forgetTerminalTopology: vi.fn(),
    invalidateResolvedWorktrees: vi.fn(),
    invalidateWorktreeScan: vi.fn(),
    notifyWorktreesChanged: vi.fn(),
    notifyReposChanged: vi.fn()
  })
  return { controller, updateRepo }
}

describe('RuntimeRepositorySettingsController.update worktreeBaseRef', () => {
  it('turns the null wire sentinel into a store clear', async () => {
    const { controller, updateRepo } = makeController()

    await controller.update('repo-1', { worktreeBaseRef: null })

    expect(updateRepo).toHaveBeenCalledWith(repo, { worktreeBaseRef: undefined })
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

    expect(updateRepo).toHaveBeenCalledWith(repo, { worktreeBaseRef: 'origin/main' })
  })
})
