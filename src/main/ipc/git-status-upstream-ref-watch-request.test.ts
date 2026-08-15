import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

const mocks = vi.hoisted(() => ({
  gitExec: vi.fn(),
  getProvider: vi.fn(),
  getProviderGeneration: vi.fn(),
  resolveRegisteredPath: vi.fn(),
  getLocalRepo: vi.fn(),
  getLocalOptions: vi.fn(),
  setWatch: vi.fn()
}))

vi.mock('../git/runner', () => ({ gitExecFileAsync: mocks.gitExec }))
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: mocks.getProvider,
  getSshGitProviderGeneration: mocks.getProviderGeneration,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'unavailable'
}))
vi.mock('./filesystem-auth', () => ({
  resolveRegisteredWorktreePath: mocks.resolveRegisteredPath
}))
vi.mock('./local-worktree-runtime-options', () => ({
  getLocalRepoForRegisteredWorktree: mocks.getLocalRepo,
  getLocalGitOptionsForRepo: mocks.getLocalOptions
}))
vi.mock('./worktree-base-directory-watcher', () => ({
  setWorktreeGitStatusRefWatch: mocks.setWatch
}))

import { applyGitStatusUpstreamRefWatchRequest } from './git-status-upstream-ref-watch-request'

describe('applyGitStatusUpstreamRefWatchRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getProviderGeneration.mockReturnValue(0)
    mocks.resolveRegisteredPath.mockResolvedValue('/resolved/repo')
    mocks.getLocalOptions.mockReturnValue({})
    mocks.setWatch.mockImplementation(
      async (_args: unknown, resolve: (signal: AbortSignal) => Promise<string | undefined>) =>
        resolve(new AbortController().signal)
    )
  })

  it('routes local exact resolution through the registered worktree runtime', async () => {
    mocks.getLocalOptions.mockReturnValue({ wslDistro: 'Ubuntu' })
    mocks.gitExec.mockResolvedValue({
      stdout: 'refs/heads/feature/main\0refs/remotes/origin/feature/main\0origin/feature/main\n'
    })

    await applyGitStatusUpstreamRefWatchRequest({} as Store, {
      worktreeId: 'repo-1::/repo',
      worktreePath: '/repo',
      executionHostId: 'wsl:Ubuntu',
      branch: 'refs/heads/feature/main',
      upstreamName: 'origin/feature/main'
    })

    expect(mocks.gitExec).toHaveBeenCalledWith(
      [
        'for-each-ref',
        '--format=%(refname)%00%(upstream)%00%(upstream:short)',
        '--count=1',
        'refs/heads/feature/main'
      ],
      expect.objectContaining({ cwd: '/resolved/repo', wslDistro: 'Ubuntu', timeout: 15_000 })
    )
  })

  it('routes SSH resolution through the current provider generation', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout:
        'refs/heads/feature/main\0refs/remotes/team/fork/feature/main\0team/fork/feature/main\n'
    })
    mocks.getProvider.mockReturnValue({ exec })
    mocks.getProviderGeneration.mockReturnValue(7)

    await applyGitStatusUpstreamRefWatchRequest({} as Store, {
      worktreeId: 'repo-1::/repo',
      worktreePath: '/repo',
      executionHostId: 'ssh:ssh-1',
      connectionId: 'ssh-1',
      branch: 'refs/heads/feature/main',
      upstreamName: 'team/fork/feature/main'
    })

    expect(mocks.setWatch).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-1', providerGeneration: 7 }),
      expect.any(Function)
    )
    expect(exec).toHaveBeenCalledWith(
      [
        'for-each-ref',
        '--format=%(refname)%00%(upstream)%00%(upstream:short)',
        '--count=1',
        'refs/heads/feature/main'
      ],
      '/repo',
      expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 15_000 })
    )
  })
})
