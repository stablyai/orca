import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

const mocks = vi.hoisted(() => ({
  gitExec: vi.fn(),
  resolveRegisteredPath: vi.fn(),
  getLocalRepo: vi.fn(),
  getLocalOptions: vi.fn(),
  setWatch: vi.fn()
}))

vi.mock('../git/runner', () => ({ gitExecFileAsync: mocks.gitExec }))
vi.mock('./registered-worktree-roots-cache', () => ({
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
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'

describe('applyGitStatusUpstreamRefWatchRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('binds the SSH watch but refuses to resolve on an SSH host', async () => {
    await expect(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SSH refusal throws before any store read.
      applyGitStatusUpstreamRefWatchRequest({} as Store, {
        worktreeId: 'repo-1::/repo',
        worktreePath: '/repo',
        executionHostId: 'ssh:ssh-1',
        connectionId: 'ssh-1',
        branch: 'refs/heads/feature/main',
        upstreamName: 'team/fork/feature/main'
      })
    ).rejects.toThrow(SshHostNotServedError)

    expect(mocks.setWatch).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-1' }),
      expect.any(Function)
    )
    expect(mocks.gitExec).not.toHaveBeenCalled()
  })
})
