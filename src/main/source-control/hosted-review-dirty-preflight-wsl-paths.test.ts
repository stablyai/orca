import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, findExistingWorktreeSymlinkPathsMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  findExistingWorktreeSymlinkPathsMock: vi.fn()
}))

vi.mock('../github/gh-utils', () => ({
  acquire: vi.fn(),
  release: vi.fn(),
  ghExecFileAsync: vi.fn(),
  gitExecFileAsync: gitExecFileAsyncMock
}))
vi.mock('../git/worktree-symlink-detection', () => ({
  findExistingWorktreeSymlinkPaths: findExistingWorktreeSymlinkPathsMock
}))

import { hasUncommittedChanges } from './hosted-review-creation-git-state'

// Why: git ran inside the distro and answered in its namespace, so the fail-closed shared-symlink
// check must lstat the host spelling — otherwise it never recognises Orca's own symlink and blocks
// review creation on a permanently "dirty" WSL worktree.
describe('hasUncommittedChanges shared-symlink probe', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    findExistingWorktreeSymlinkPathsMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '?? node_modules\0', stderr: '' })
    findExistingWorktreeSymlinkPathsMock.mockResolvedValue(['node_modules'])
  })

  it('passes the configured distro through to the probe', async () => {
    await expect(
      hasUncommittedChanges('/home/me/repo/feature', 'local', {
        localGitExecOptions: { wslDistro: 'Ubuntu' },
        sharedLinkPaths: ['node_modules']
      })
    ).resolves.toBe(false)

    expect(findExistingWorktreeSymlinkPathsMock).toHaveBeenCalledWith(
      '/home/me/repo/feature',
      ['node_modules'],
      { wslDistro: 'Ubuntu' }
    )
  })
})
