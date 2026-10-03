import { describe, expect, it, vi } from 'vitest'

const { detachedBranchUse } = vi.hoisted(() => ({ detachedBranchUse: vi.fn(async () => false) }))
vi.mock('../../shared/git-worktree-admin', () => ({
  isBranchInDetachedWorktree: detachedBranchUse
}))
vi.mock('./local-repo-ref-maintenance', () => ({
  withRepoRefMaintenancePaused: (_reason: string, run: () => unknown) => run()
}))

import { forceDeleteLocalBranch } from './worktree-branch-removal'

describe('preserved branch cleanup execution-host options', () => {
  it('uses the same WSL distro for both detached admin guards and the ref mutation', async () => {
    const repoPath = String.raw`\\wsl.localhost\Ubuntu\home\user\repo`
    const options = { wslDistro: 'Ubuntu' }
    const runGit = vi.fn(async (argv: string[]) => ({
      stdout:
        argv[0] === 'worktree'
          ? 'worktree /home/user/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/user/detached\nHEAD abc\ndetached\n'
          : '',
      stderr: ''
    }))
    await forceDeleteLocalBranch(repoPath, 'feature', 'abc', runGit, options)
    expect(detachedBranchUse).toHaveBeenCalledTimes(2)
    for (const call of detachedBranchUse.mock.calls) {
      expect(call).toEqual([repoPath, 'feature', expect.any(Array), options])
    }
    expect(runGit).toHaveBeenCalledWith(['update-ref', '-d', 'refs/heads/feature', 'abc'], repoPath)
  })
})
