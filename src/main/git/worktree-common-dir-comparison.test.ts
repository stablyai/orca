// The common-dir check decides whether a create is confirmed, so a false accept adopts a foreign repo.
import { describe, expect, it } from 'vitest'
import { isSameCommonDirPath } from './worktree-listing'

describe('isSameCommonDirPath', () => {
  it('keeps WSL paths case-sensitive on a Windows host', () => {
    expect(isSameCommonDirPath('/home/u/RepoA/.git', '/home/u/repoa/.git', 'win32')).toBe(false)
    expect(isSameCommonDirPath('/home/u/repoa/.git', '/home/u/repoa/.git', 'win32')).toBe(true)
  })

  it('refuses to compare a Linux path against a Windows one', () => {
    expect(isSameCommonDirPath('/home/u/repo/.git', 'C:\\repo\\.git', 'win32')).toBe(false)
    expect(
      isSameCommonDirPath('/home/u/repo/.git', '\\\\wsl.localhost\\Ubuntu\\home\\u\\repo\\.git')
    ).toBe(false)
  })

  it('still folds drive-letter case and slash style for Windows paths', () => {
    expect(isSameCommonDirPath('C:\\Repo\\.git', 'c:/repo/.git', 'win32')).toBe(true)
  })

  it('normalizes without folding case on a POSIX host', () => {
    expect(isSameCommonDirPath('/repo/./x/../.git', '/repo/.git', 'linux')).toBe(true)
    expect(isSameCommonDirPath('/repo/.GIT', '/repo/.git', 'linux')).toBe(false)
  })
})
