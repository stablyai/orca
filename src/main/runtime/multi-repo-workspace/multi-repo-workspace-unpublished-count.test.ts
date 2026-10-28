import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readUnpublishedCommitCount } from './multi-repo-workspace-delete'

const git = (cwd: string, ...args: string[]): void => {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: 'ignore' }
  )
}

describe('readUnpublishedCommitCount', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function setup(): { repo: string; worktree: string } {
    const root = mkdtempSync(join(tmpdir(), 'unpublished-count-'))
    dirs.push(root)
    const repo = join(root, 'repo')
    git(root, 'init', '-q', '-b', 'main', repo)
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'one')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'two')
    const worktree = join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree)
    return { repo, worktree }
  }

  it('counts nothing for a branch that only has the history of its base', async () => {
    const { repo, worktree } = setup()
    expect(await readUnpublishedCommitCount(worktree, repo, undefined)).toBe(0)
  })

  it('counts only the commits the branch added on top of its base', async () => {
    const { repo, worktree } = setup()
    git(worktree, 'commit', '-q', '--allow-empty', '-m', 'own')
    expect(await readUnpublishedCommitCount(worktree, repo, 'main')).toBe(1)
    git(worktree, 'commit', '-q', '--allow-empty', '-m', 'own 2')
    expect(await readUnpublishedCommitCount(worktree, repo, 'main')).toBe(2)
  })
})
