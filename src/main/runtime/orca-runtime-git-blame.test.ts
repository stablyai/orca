import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/types'
import { RuntimeGitCommands, type ResolvedRuntimeGitWorktree } from './orca-runtime-git'

const mocks = vi.hoisted(() => ({
  getBlame: vi.fn(),
  getSshGitProvider: vi.fn()
}))

vi.mock('../git/blame', () => ({
  getBlame: mocks.getBlame
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: mocks.getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'Remote connection dropped.'
}))

/** Creates a resolved runtime worktree fixture for the given path. */
function makeWorktree(path: string): ResolvedRuntimeGitWorktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path,
    git: {
      path,
      branch: 'main',
      isBare: false,
      isMainWorktree: false,
      head: 'a'.repeat(40)
    }
  } as unknown as ResolvedRuntimeGitWorktree
}

/** Creates RuntimeGitCommands against a fixed worktree path. */
function makeCommands(worktreePath: string): RuntimeGitCommands {
  return new RuntimeGitCommands({
    resolveRuntimeGitTarget: async () => ({ worktree: makeWorktree(worktreePath) }),
    getRuntimeSettings: () => ({}) as GlobalSettings
  })
}

describe('RuntimeGitCommands blame path handling', () => {
  beforeEach(() => {
    mocks.getBlame.mockReset()
    mocks.getSshGitProvider.mockReset()
  })

  it('resolves absolute blame paths against the selected worktree', async () => {
    const worktreePath = '/repo'
    mocks.getBlame.mockResolvedValue([])

    await makeCommands(worktreePath).getRuntimeGitBlame('id:wt-1', `${worktreePath}/src/a.ts`)

    expect(mocks.getBlame).toHaveBeenCalledWith(worktreePath, 'src/a.ts', {})
  })

  it('rejects absolute blame paths outside the selected worktree', async () => {
    const commands = makeCommands('/repo')

    await expect(commands.getRuntimeGitBlame('id:wt-1', '/other/src/a.ts')).rejects.toThrow(
      'invalid_relative_path'
    )
    expect(mocks.getBlame).not.toHaveBeenCalled()
  })

  it('forwards normalized blame paths through the SSH provider', async () => {
    const provider = { getBlame: vi.fn().mockResolvedValue([]) }
    mocks.getSshGitProvider.mockReturnValue(provider as never)
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => ({
        worktree: makeWorktree('/remote'),
        connectionId: 'ssh-1'
      }),
      getRuntimeSettings: () => ({}) as GlobalSettings
    })

    await commands.getRuntimeGitBlame('id:wt-1', '/remote/src/a.ts')

    expect(provider.getBlame).toHaveBeenCalledWith('/remote', 'src/a.ts')
  })
})
