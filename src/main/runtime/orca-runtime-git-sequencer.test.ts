import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { RuntimeGitCommands, type ResolvedRuntimeGitWorktree } from './orca-runtime-git'

const mocks = vi.hoisted(() => ({
  continueSequencer: vi.fn(),
  getSshGitProvider: vi.fn()
}))

vi.mock('../git/sequencer-actions', () => ({
  continueSequencer: mocks.continueSequencer
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: mocks.getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'unavailable'
}))

const OPERATIONS = ['merge', 'rebase', 'cherry-pick'] as const

function makeCommands(connectionId?: string): RuntimeGitCommands {
  const worktree = { id: 'wt-1', repoId: 'repo-1', path: '/repo' } as ResolvedRuntimeGitWorktree
  return new RuntimeGitCommands({
    resolveRuntimeGitTarget: async () => ({
      worktree,
      ...(connectionId ? { connectionId } : {})
    }),
    getRuntimeSettings: () => ({}) as GlobalSettings
  })
}

describe('RuntimeGitCommands sequencer continue', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset()
    }
  })

  it.each(OPERATIONS)('continues a %s against the resolved worktree', async (operation) => {
    mocks.continueSequencer.mockResolvedValue(undefined)

    await expect(makeCommands().continueRuntimeGitSequencer('id:wt-1', operation)).resolves.toEqual(
      { ok: true }
    )

    expect(mocks.continueSequencer).toHaveBeenCalledWith(operation, '/repo', {})
  })

  it.each(OPERATIONS)('routes a %s through the SSH git provider', async (operation) => {
    const provider = { continueSequencer: vi.fn().mockResolvedValue(undefined) }
    mocks.getSshGitProvider.mockReturnValue(provider)

    await expect(
      makeCommands('conn-1').continueRuntimeGitSequencer('id:wt-1', operation)
    ).resolves.toEqual({ ok: true })

    expect(provider.continueSequencer).toHaveBeenCalledWith('/repo', operation)
    expect(mocks.continueSequencer).not.toHaveBeenCalled()
  })

  it('fails when the SSH git provider is missing', async () => {
    mocks.getSshGitProvider.mockReturnValue(null)

    await expect(
      makeCommands('conn-1').continueRuntimeGitSequencer('id:wt-1', 'rebase')
    ).rejects.toThrow()
    expect(mocks.continueSequencer).not.toHaveBeenCalled()
  })
})
