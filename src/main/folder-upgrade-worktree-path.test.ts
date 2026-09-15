import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Repo } from '../shared/repo-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { preserveFolderUpgradeWorktreePath } from './folder-upgrade-worktree-path'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const repo: Repo = {
  id: 'folder',
  path: 'C:\\projects\\draft',
  displayName: 'draft',
  badgeColor: 'blue',
  addedAt: 0,
  kind: 'git',
  folderUpgradeGitRootPath: 'C:/projects/draft'
}

function row(path: string): GitWorktreeInfo {
  return { path, branch: 'draft', head: 'abc', isBare: false, isMainWorktree: false }
}

describe('upgraded folder path projection', () => {
  it('leaves existing Git repos and unrelated linked checkouts untouched', () => {
    const rows = [row('C:/projects/draft'), row('C:/projects/other')]
    expect(
      preserveFolderUpgradeWorktreePath({ ...repo, folderUpgradeGitRootPath: undefined }, rows)
    ).toBe(rows)
    expect(preserveFolderUpgradeWorktreePath(repo, rows)).toEqual([
      { ...rows[0], path: repo.path },
      rows[1]
    ])
    expect(rows[0].path).toBe('C:/projects/draft')
  })

  it('is idempotent and does not publish both Windows separator spellings', () => {
    const rows = [row(repo.path), row('c:/projects/draft')]
    const projected = preserveFolderUpgradeWorktreePath(repo, rows)
    expect(projected).toEqual([row(repo.path)])
    expect(preserveFolderUpgradeWorktreePath(repo, projected)).toEqual(projected)
  })

  it('does not equate case-distinct POSIX workspaces', () => {
    const owner = { ...repo, path: '/project/draft', folderUpgradeGitRootPath: '/project/draft' }
    const rows = [row('/project/draft'), row('/project/Draft')]
    expect(preserveFolderUpgradeWorktreePath(owner, rows)).toEqual(rows)
  })

  it('revalidates a symlink locally and refuses to inspect a remote symlink', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-folder-upgrade-path-')))
    roots.push(root)
    const target = join(root, 'target')
    const other = join(root, 'other')
    const alias = join(root, 'alias')
    mkdirSync(target)
    mkdirSync(other)
    symlinkSync(target, alias, 'junction')
    const owner = { ...repo, path: alias, folderUpgradeGitRootPath: target }
    const rows = [row(target)]
    expect(preserveFolderUpgradeWorktreePath(owner, rows)).toEqual([row(alias)])
    expect(
      preserveFolderUpgradeWorktreePath({ ...owner, executionHostId: 'ssh:builder' }, rows)
    ).toBe(rows)
    rmSync(alias)
    symlinkSync(other, alias, 'junction')
    expect(preserveFolderUpgradeWorktreePath(owner, rows)).toBe(rows)
  })
})
