import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, readWorktreeGitPathMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  readWorktreeGitPathMock: vi.fn()
}))

vi.mock('./command-runner/git-exec-file', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
vi.mock('./worktree-git-path', () => ({ readWorktreeGitPath: readWorktreeGitPathMock }))
vi.mock('../wsl/wsl-automount-root', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  knownWslAutomountRoots: () => ['/mnt/']
}))

import { resolveWslWorktreeGitPath } from './wsl-worktree-git-path'

const WORKTREE = '\\\\wsl.localhost\\Ubuntu\\home\\jin\\feature'
const FROM_LINK =
  '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.sh'

describe('resolveWslWorktreeGitPath', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    readWorktreeGitPathMock.mockReset()
  })

  it('uses the .git link without running Git', async () => {
    readWorktreeGitPathMock.mockReturnValue(FROM_LINK)

    await expect(resolveWslWorktreeGitPath(WORKTREE, 'orca/setup-runner.sh')).resolves.toBe(
      FROM_LINK
    )
    expect(readWorktreeGitPathMock).toHaveBeenCalledWith(WORKTREE, 'orca/setup-runner.sh', [
      '/mnt/'
    ])
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('retries the link once after a transient miss', async () => {
    readWorktreeGitPathMock.mockReturnValueOnce(null).mockReturnValueOnce(FROM_LINK)

    await expect(resolveWslWorktreeGitPath(WORKTREE, 'orca/setup-runner.sh')).resolves.toBe(
      FROM_LINK
    )
    expect(readWorktreeGitPathMock).toHaveBeenCalledTimes(2)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it("asks the distro's Git when the link stays unreadable", async () => {
    readWorktreeGitPathMock.mockReturnValue(null)
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: '/home/jin/repo/.git/worktrees/feature/orca/setup-runner.sh\n',
      stderr: ''
    })

    await expect(resolveWslWorktreeGitPath(WORKTREE, 'orca/setup-runner.sh')).resolves.toBe(
      FROM_LINK
    )
    expect(readWorktreeGitPathMock).toHaveBeenCalledTimes(2)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--git-path', 'orca/setup-runner.sh'],
      { cwd: WORKTREE }
    )
  })

  it("maps Git's mounted-drive answer to the Windows drive", async () => {
    readWorktreeGitPathMock.mockReturnValue(null)
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: '/mnt/c/src/repo/.git/worktrees/feature/orca/setup-runner.sh\n',
      stderr: ''
    })

    await expect(resolveWslWorktreeGitPath(WORKTREE, 'orca/setup-runner.sh')).resolves.toBe(
      'C:\\src\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.sh'
    )
  })

  it("resolves Git's worktree-relative answer against the worktree", async () => {
    readWorktreeGitPathMock.mockReturnValue(null)
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '.git/orca/setup-runner.sh\n', stderr: '' })

    await expect(resolveWslWorktreeGitPath(WORKTREE, 'orca/setup-runner.sh')).resolves.toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\jin\\feature\\.git\\orca\\setup-runner.sh'
    )
  })

  it("names the worktree and keeps Git's error when both fail", async () => {
    readWorktreeGitPathMock.mockReturnValue(null)
    const gitError = new Error('fatal: not a git repository')
    gitExecFileAsyncMock.mockRejectedValue(gitError)

    const failure = resolveWslWorktreeGitPath(WORKTREE, 'orca/setup-runner.sh')
    await expect(failure).rejects.toThrow(/couldn't find this WSL worktree's Git folder/)
    await expect(failure).rejects.toMatchObject({ cause: gitError })
  })
})
