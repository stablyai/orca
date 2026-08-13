import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn(),
  translateWslOutputPaths: (output: string) => output
}))

import { clearGitCapabilityStateForTests } from './git-capability-state'
import { listWorktrees, listWorktreesStrict } from './worktree'

function enoentError(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'ENOENT' })
}

describe('listWorktrees failure contract', () => {
  beforeEach(() => {
    clearGitCapabilityStateForTests()
    gitExecFileAsyncMock.mockReset()
  })

  it.each([
    ['timeout', new Error('wsl.exe timed out')],
    ['missing path', enoentError('ENOENT: no such file or directory')],
    [
      'not a repository',
      new Error('fatal: not a git repository (or any of the parent directories): .git')
    ]
  ])(
    'swallows a %s failure in the forgiving list and rethrows it from the strict list',
    async (_label, error) => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        gitExecFileAsyncMock.mockRejectedValue(error)
        await expect(listWorktrees('C:/repo')).resolves.toEqual([])
        await expect(listWorktreesStrict('C:/repo')).rejects.toThrow(error)
        await expect(listWorktreesStrict('C:/repo', { wslDistro: 'Ubuntu' })).rejects.toThrow(error)
        expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
          ['worktree', 'list', '--porcelain', '-z'],
          expect.objectContaining({ cwd: 'C:/repo', wslDistro: 'Ubuntu' })
        )
      } finally {
        warnSpy.mockRestore()
      }
    }
  )
})
