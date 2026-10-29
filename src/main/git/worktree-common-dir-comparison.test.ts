import { describe, expect, it } from 'vitest'
import { areWorktreePathsEqual } from './worktree-path-comparison'

describe('comparing git common dirs', () => {
  it('keeps WSL paths case-sensitive on a Windows host', () => {
    expect(areWorktreePathsEqual('/home/u/RepoA/.git', '/home/u/repoa/.git', 'win32')).toBe(false)
    expect(areWorktreePathsEqual('/home/u/repoa/.git', '/home/u/repoa/.git', 'win32')).toBe(true)
    expect(
      areWorktreePathsEqual(
        '\\\\wsl.localhost\\Ubuntu\\home\\u\\RepoA\\.git',
        '\\\\wsl.localhost\\Ubuntu\\home\\u\\repoa\\.git',
        'win32'
      )
    ).toBe(false)
  })

  it('refuses to compare a Linux path against a Windows one', () => {
    expect(areWorktreePathsEqual('/home/u/repo/.git', 'C:\\repo\\.git', 'win32')).toBe(false)
    expect(
      areWorktreePathsEqual('/home/u/repo/.git', '\\\\wsl.localhost\\Ubuntu\\home\\u\\repo\\.git')
    ).toBe(false)
  })

  it('still folds drive-letter case and slash style for Windows paths', () => {
    expect(areWorktreePathsEqual('C:\\Repo\\.git', 'c:/repo/.git', 'win32')).toBe(true)
  })

  it('normalizes without folding case on a POSIX host', () => {
    expect(areWorktreePathsEqual('/repo/./x/../.git', '/repo/.git', 'linux')).toBe(true)
    expect(areWorktreePathsEqual('/repo/.GIT', '/repo/.git', 'linux')).toBe(false)
  })

  it('treats /tmp and /private/tmp as one directory on macOS only', () => {
    expect(areWorktreePathsEqual('/private/tmp/r/.git', '/tmp/r/.git', 'darwin')).toBe(true)
    expect(areWorktreePathsEqual('/private/tmp/r/.git', '/tmp/r/.git', 'linux')).toBe(false)
  })
})
