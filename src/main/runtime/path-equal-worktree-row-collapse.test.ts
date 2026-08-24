import { describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import {
  collapsePathEqualWorktreeRows,
  resolveRepoWorktreePathPlatform
} from './path-equal-worktree-row-collapse'

function row(path: string, overrides: Partial<GitWorktreeInfo> = {}): GitWorktreeInfo {
  return {
    path,
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    ...overrides
  }
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo',
    path: '/home/me/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1,
    ...overrides
  }
}

describe('collapsePathEqualWorktreeRows', () => {
  it.each<NodeJS.Platform>(['darwin', 'linux'])(
    'keeps case-different POSIX paths apart on %s',
    (platform) => {
      const rows = [row('/home/me/Repo'), row('/home/me/repo')]

      expect(
        collapsePathEqualWorktreeRows(rows, { repoPath: '/home/me/repo', platform }).map(
          (entry) => entry.path
        )
      ).toEqual(['/home/me/Repo', '/home/me/repo'])
    }
  )

  it('collapses Windows slash styles and drive-letter casing', () => {
    const rows = [row(String.raw`C:\Work\Feature`), row('c:/work/feature/')]

    expect(
      collapsePathEqualWorktreeRows(rows, {
        repoPath: String.raw`C:\Work`,
        platform: 'win32'
      }).map((entry) => entry.path)
    ).toEqual([String.raw`C:\Work\Feature`])
  })

  it.each<NodeJS.Platform>(['win32', 'linux', 'darwin'])(
    'keeps case-different WSL UNC worktrees apart on %s',
    (platform) => {
      const rows = [
        row(String.raw`\\wsl$\Ubuntu\home\me\wt\Feature`, { branch: 'refs/heads/Feature' }),
        row(String.raw`\\wsl$\Ubuntu\home\me\wt\feature`, { branch: 'refs/heads/feature' }),
        row(String.raw`\\wsl.localhost\Ubuntu\home\me\wt\Other`),
        row(String.raw`\\wsl.localhost\Ubuntu\home\me\wt\other`)
      ]

      expect(
        collapsePathEqualWorktreeRows(rows, {
          repoPath: String.raw`\\wsl$\Ubuntu\home\me\repo`,
          platform
        }).map((entry) => entry.path)
      ).toEqual(rows.map((entry) => entry.path))
    }
  )

  it('collapses WSL UNC rows differing only by separator, dot segment or distro case', () => {
    const rows = [
      row(String.raw`\\wsl$\Ubuntu\home\me\wt\Feature`),
      row('//wsl$/ubuntu/home/me/wt/./Feature/'),
      row(String.raw`\\WSL$\Ubuntu\home\me\wt\Feature`)
    ]

    expect(
      collapsePathEqualWorktreeRows(rows, {
        repoPath: String.raw`\\wsl$\Ubuntu\home\me\repo`,
        platform: 'win32'
      }).map((entry) => entry.path)
    ).toEqual([String.raw`\\wsl$\Ubuntu\home\me\wt\Feature`])
  })

  it('keeps /tmp and /private/tmp apart for rows produced on a non-darwin host', () => {
    const rows = [row('/private/tmp/orca/feature'), row('/tmp/orca/feature')]

    expect(
      collapsePathEqualWorktreeRows(rows, { repoPath: '/tmp/orca', platform: 'linux' }).map(
        (entry) => entry.path
      )
    ).toEqual(['/private/tmp/orca/feature', '/tmp/orca/feature'])
    expect(
      collapsePathEqualWorktreeRows(rows, { repoPath: '/tmp/orca', platform: 'darwin' })
    ).toHaveLength(1)
  })

  it('collapses in place and merges the peer branch, head and flags', () => {
    const rows = [
      row('/home/me/repo/', { head: '', branch: '', isMainWorktree: false }),
      row('/home/me/wt/feature', { branch: 'refs/heads/feature' }),
      row('/home/me/repo', { branch: 'refs/heads/master', isMainWorktree: true, isSparse: true })
    ]

    const collapsed = collapsePathEqualWorktreeRows(rows, {
      repoPath: '/home/me/repo',
      platform: 'linux'
    })

    expect(collapsed).toHaveLength(2)
    expect(collapsed[0]).toMatchObject({
      path: '/home/me/repo',
      head: 'abc123',
      branch: 'refs/heads/master',
      isMainWorktree: true,
      isSparse: true
    })
    expect(collapsed[1].path).toBe('/home/me/wt/feature')
  })

  it('prefers a spelling that already owns metadata over git row order', () => {
    const rows = [row('/home/me/wt/./feature'), row('/home/me/wt/feature')]

    expect(
      collapsePathEqualWorktreeRows(rows, {
        repoPath: '/home/me/repo',
        hasStoredMeta: (path) => path === '/home/me/wt/feature',
        platform: 'linux'
      })[0].path
    ).toBe('/home/me/wt/feature')
  })
})

describe('resolveRepoWorktreePathPlatform', () => {
  it('treats remote-host rows as plain POSIX regardless of the desktop platform', () => {
    expect(resolveRepoWorktreePathPlatform(repo({ connectionId: 'builder' }))).toBe('linux')
    expect(resolveRepoWorktreePathPlatform(repo({ executionHostId: 'runtime:sandbox' }))).toBe(
      'linux'
    )
    expect(resolveRepoWorktreePathPlatform(repo())).toBe(process.platform)
  })
})
