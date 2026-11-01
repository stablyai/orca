import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

const mocks = vi.hoisted(() => ({
  gitExec: vi.fn(),
  resolveRegisteredPath: vi.fn(),
  getLocalRepo: vi.fn(),
  getLocalOptions: vi.fn(),
  setWatch: vi.fn(),
  isWslDistroRunning: vi.fn(async () => true)
}))
vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWslDistroRunningState: async () =>
    (await mocks.isWslDistroRunning()) ? 'running' : 'stopped'
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
import { WslDistroStoppedError } from '../wsl/wsl-unc-access-gate'

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

  it('does not run Git in a stopped WSL distro (E9)', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      mocks.getLocalOptions.mockReturnValue({ wslDistro: 'Ubuntu' })
      mocks.isWslDistroRunning.mockResolvedValueOnce(false)
      await expect(
        applyGitStatusUpstreamRefWatchRequest({} as Store, {
          worktreeId: 'repo-1::/repo',
          worktreePath: '/repo',
          executionHostId: 'wsl:Ubuntu',
          branch: 'refs/heads/main',
          upstreamName: 'origin/main'
        })
      ).rejects.toBeInstanceOf(WslDistroStoppedError)
      expect(mocks.gitExec).not.toHaveBeenCalled()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })
})
