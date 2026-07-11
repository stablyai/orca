import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listWorktrees, removeWorktree } from './worktree'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}

async function createRepoWithNewlineWorktree(): Promise<{
  repoPath: string
  worktreePath: string
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-worktree-paths-'))
  tempRoots.push(root)
  const repoPath = path.join(root, 'repo')
  const requestedWorktreePath = path.join(root, 'linked\nworktree')

  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  git(repoPath, ['commit', '--allow-empty', '--quiet', '-m', 'initial'])
  git(repoPath, ['worktree', 'add', '--quiet', '-b', 'feature/newline', requestedWorktreePath])

  return {
    repoPath: await realpath(repoPath),
    worktreePath: await realpath(requestedWorktreePath)
  }
}

async function createRepoWithLockedDeletedWorktree(): Promise<{
  repoPath: string
  worktreePath: string
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-worktree-locked-delete-'))
  tempRoots.push(root)
  const repoPath = path.join(root, 'repo')
  const requestedWorktreePath = path.join(root, 'locked deleted worktree')

  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  git(repoPath, ['commit', '--allow-empty', '--quiet', '-m', 'initial'])
  git(repoPath, [
    'worktree',
    'add',
    '--quiet',
    '-b',
    'feature/locked-delete',
    requestedWorktreePath
  ])
  git(repoPath, ['worktree', 'lock', '--reason', 'orca locked stale repro', requestedWorktreePath])

  const worktreePath = await realpath(requestedWorktreePath)
  await rm(worktreePath, { recursive: true, force: true })

  return {
    repoPath: await realpath(repoPath),
    worktreePath
  }
}

function branchExists(repoPath: string, branchName: string): boolean {
  try {
    git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`])
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('git worktree paths', () => {
  it.skipIf(process.platform === 'win32')(
    'lists worktrees whose paths contain newlines',
    async () => {
      const { repoPath, worktreePath } = await createRepoWithNewlineWorktree()

      const worktrees = await listWorktrees(repoPath)

      expect(worktrees.map((worktree) => worktree.path)).toContain(worktreePath)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'deletes the matching local branch after removing a newline-path worktree',
    async () => {
      const { repoPath, worktreePath } = await createRepoWithNewlineWorktree()

      await removeWorktree(repoPath, worktreePath)

      expect(branchExists(repoPath, 'feature/newline')).toBe(false)
    }
  )

  it('preserves a locked worktree whose directory was deleted manually', async () => {
    const { repoPath, worktreePath } = await createRepoWithLockedDeletedWorktree()

    await expect(removeWorktree(repoPath, worktreePath, true)).rejects.toThrow(
      'Worktree is locked by Git'
    )

    expect(git(repoPath, ['worktree', 'list', '--porcelain'])).toContain(
      worktreePath.replaceAll('\\', '/')
    )
    expect(branchExists(repoPath, 'feature/locked-delete')).toBe(true)
  })
})
