import { describe, expect, it } from 'vitest'
import type { Repo } from '../shared/types'
import { normalizeRepoWorktreeFolderPath } from './repo-worktree-folder-path'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repos/app',
    displayName: 'app',
    badgeColor: '#000',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

describe('repo worktree folder path normalization', () => {
  it('trims POSIX paths and clears empty input', () => {
    const repo = makeRepo()

    expect(normalizeRepoWorktreeFolderPath('  /worktrees/app  ', repo)).toBe('/worktrees/app')
    expect(normalizeRepoWorktreeFolderPath('   ', repo)).toBeUndefined()
  })

  it('rejects malformed POSIX project folders', () => {
    const repo = makeRepo()

    expect(() => normalizeRepoWorktreeFolderPath('relative/path', repo)).toThrow('absolute')
    expect(() => normalizeRepoWorktreeFolderPath('/', repo)).toThrow('filesystem root')
    expect(() => normalizeRepoWorktreeFolderPath('/tmp/\u0000bad', repo)).toThrow(
      'control characters'
    )
    expect(() => normalizeRepoWorktreeFolderPath(42, repo)).toThrow('must be a string')
  })

  it('normalizes Windows drive and UNC paths for Windows-shaped repos', () => {
    const repo = makeRepo({ path: 'C:\\repos\\app' })

    expect(normalizeRepoWorktreeFolderPath('C:/worktrees/app', repo)).toBe('C:\\worktrees\\app')
    expect(normalizeRepoWorktreeFolderPath('\\\\Server\\Share\\worktrees', repo)).toBe(
      '\\\\Server\\Share\\worktrees'
    )
    expect(() => normalizeRepoWorktreeFolderPath('C:\\', repo)).toThrow('filesystem root')
    expect(() => normalizeRepoWorktreeFolderPath('\\\\Server\\Share', repo)).toThrow(
      'filesystem root'
    )
  })

  it('keeps desktop-local WSL overrides inside the repo distro filesystem', () => {
    const repo = makeRepo({ path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\src\\app' })

    expect(normalizeRepoWorktreeFolderPath('/home/me/worktrees', repo)).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\worktrees'
    )
    expect(
      normalizeRepoWorktreeFolderPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\worktrees', repo)
    ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\worktrees')
    expect(() => normalizeRepoWorktreeFolderPath('D:\\worktrees', repo)).toThrow('WSL')
    expect(() => normalizeRepoWorktreeFolderPath('/mnt/c/worktrees', repo)).toThrow('/mnt/<drive>')
    expect(() =>
      normalizeRepoWorktreeFolderPath('\\\\wsl.localhost\\Debian\\home\\me\\worktrees', repo)
    ).toThrow('same distro')
  })

  it('strips folder-mode worktree folders', () => {
    expect(
      normalizeRepoWorktreeFolderPath('/worktrees/app', makeRepo({ kind: 'folder' }))
    ).toBeUndefined()
  })
})
