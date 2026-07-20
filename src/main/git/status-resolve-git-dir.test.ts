import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { resolveGitDir } from './status'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
}

function initRepoWithCommit(parent: string, name: string): string {
  const dir = path.join(parent, name)
  git(parent, ['init', '--quiet', name])
  git(dir, ['config', 'user.email', 'test@test.com'])
  git(dir, ['config', 'user.name', 'Test'])
  git(dir, ['commit', '--allow-empty', '-m', 'initial', '--quiet'])
  return dir
}

describe('resolveGitDir', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orca-resolve-git-dir-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns <path>/.git for a regular checkout', async () => {
    const repo = path.join(tmpDir, 'repo')
    git(tmpDir, ['init', '--quiet', 'repo'])

    await expect(resolveGitDir(repo)).resolves.toBe(path.join(repo, '.git'))
  })

  it('resolves the gitdir file of a linked worktree', async () => {
    const repo = initRepoWithCommit(tmpDir, 'repo')
    const linked = path.join(tmpDir, 'linked')
    git(repo, ['worktree', 'add', '--quiet', linked])

    await expect(resolveGitDir(linked)).resolves.toBe(
      path.join(repo, '.git', 'worktrees', 'linked')
    )
  })

  it('returns the repo path itself for a bare repo', async () => {
    // Why: a bare repo has no `.git` entry — the repo path IS the git dir.
    // Returning the previous `<path>/.git` pointed consumers at a
    // nonexistent location.
    const bare = path.join(tmpDir, 'hub.git')
    git(tmpDir, ['init', '--bare', '--quiet', 'hub.git'])

    await expect(resolveGitDir(bare)).resolves.toBe(bare)
  })

  it('still returns <path>/.git for a missing path with no git markers', async () => {
    const missing = path.join(tmpDir, 'missing')

    await expect(resolveGitDir(missing)).resolves.toBe(path.join(missing, '.git'))
  })
})
