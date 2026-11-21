import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Repo } from '../../../shared/repository/repo-types'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import {
  preserveFolderUpgradeWorktreePath,
  preserveFolderUpgradeWorktreePathAsync
} from './folder-upgrade-worktree-path'

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

describe.each([
  ['sync', preserveFolderUpgradeWorktreePath],
  ['async', preserveFolderUpgradeWorktreePathAsync]
] as const)('upgraded folder path projection (%s)', (_name, preserve) => {
  it('leaves existing Git repos and unrelated linked checkouts untouched', async () => {
    const rows = [row('C:/projects/draft'), row('C:/projects/other')]
    expect(await preserve({ ...repo, folderUpgradeGitRootPath: undefined }, rows)).toBe(rows)
    expect(await preserve(repo, rows)).toEqual([{ ...rows[0], path: repo.path }, rows[1]])
    expect(rows[0].path).toBe('C:/projects/draft')
  })

  it('does not publish both Windows separator spellings', async () => {
    const rows = [row(repo.path), row('c:/projects/draft')]
    const projected = await preserve(repo, rows)
    expect(projected).toEqual([row(repo.path)])
  })

  it('does not equate case-distinct POSIX workspaces', async () => {
    const owner = { ...repo, path: '/project/draft', folderUpgradeGitRootPath: '/project/draft' }
    const rows = [row('/project/draft'), row('/project/Draft')]
    expect(await preserve(owner, rows)).toEqual(rows)
  })

  it('revalidates a symlink locally and refuses to inspect a remote symlink', async () => {
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
    expect(await preserve(owner, rows)).toEqual([row(alias)])
    expect(await preserve({ ...owner, executionHostId: 'ssh:builder' }, rows)).toBe(rows)
    rmSync(alias)
    symlinkSync(other, alias, 'junction')
    expect(await preserve(owner, rows)).toBe(rows)
  })
})
