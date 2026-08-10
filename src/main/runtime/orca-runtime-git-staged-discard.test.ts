import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/types'
import { RuntimeGitCommands, type ResolvedRuntimeGitWorktree } from './orca-runtime-git'

const mocks = vi.hoisted(() => ({
  getSshGitProvider: vi.fn()
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: mocks.getSshGitProvider
}))

function makeRemoteWorktree(): ResolvedRuntimeGitWorktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/remote/repo',
    linkedIssue: null,
    git: {
      path: '/remote/repo',
      branch: 'main',
      isBare: false,
      isMainWorktree: false,
      head: 'a'.repeat(40)
    }
  } as ResolvedRuntimeGitWorktree
}

describe('RuntimeGitCommands staged discard settlement', () => {
  beforeEach(() => {
    mocks.getSshGitProvider.mockReset()
  })

  it('propagates terminal SSH settlement instead of caching an outer pending receipt', async () => {
    const pending = {
      operationId: 'op-layered',
      state: 'pending' as const,
      mutation: 'possible' as const,
      affectedPaths: ['a.ts'],
      completedPaths: [],
      uncertainPaths: ['a.ts'],
      remainingPaths: []
    }
    const succeeded = {
      operationId: 'op-layered',
      state: 'succeeded' as const,
      mutation: 'complete' as const,
      affectedPaths: ['a.ts'],
      completedPaths: ['a.ts'],
      uncertainPaths: [],
      remainingPaths: []
    }
    const provider = {
      bulkDiscardStagedChanges: vi.fn().mockResolvedValue(pending),
      getStagedDiscardReceipt: vi.fn().mockResolvedValue(succeeded)
    }
    mocks.getSshGitProvider.mockReturnValue(provider)
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => ({
        worktree: makeRemoteWorktree(),
        connectionId: 'conn-1'
      }),
      getRuntimeSettings: () => ({}) as GlobalSettings
    })

    await expect(
      commands.bulkDiscardStagedRuntimeGitPaths('id:wt-1', ['a.ts'], 'op-layered')
    ).resolves.toEqual(pending)
    await expect(
      commands.getStagedDiscardRuntimeGitReceipt('id:wt-1', 'op-layered')
    ).resolves.toEqual(succeeded)
    await expect(
      commands.getStagedDiscardRuntimeGitReceipt('id:wt-1', 'op-layered')
    ).resolves.toEqual(succeeded)
    expect(provider.getStagedDiscardReceipt).toHaveBeenCalledTimes(1)
  })
})
