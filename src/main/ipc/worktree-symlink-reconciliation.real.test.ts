import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findCreatedWorktree } from './created-worktree-reconciliation'
import { areWorktreePathsEqual } from './worktree-path-comparison'

type ListedWorktree = { path: string; branch?: string }

const fixtureRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  )
})

describe('native worktree symlink reconciliation (real Git)', () => {
  it('matches the authoritative listed row after adding through a symlink root', async () => {
    const fixtureRoot = await mkdtemp(join(process.cwd(), '.pr-10172-real-git-'))
    fixtureRoots.push(fixtureRoot)
    const repoPath = join(fixtureRoot, 'repo')
    const canonicalRoot = join(fixtureRoot, 'canonical-worktrees')
    const aliasRoot = join(fixtureRoot, 'visible-worktrees')
    const stalePath = join(aliasRoot, 'aaa-stale')
    const requestedPath = join(aliasRoot, 'feature')
    await mkdir(repoPath)
    await mkdir(canonicalRoot)
    await symlink(canonicalRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir')

    git(repoPath, ['init', '--quiet'])
    git(repoPath, ['config', 'user.email', 'review@example.invalid'])
    git(repoPath, ['config', 'user.name', 'PR review'])
    await writeFile(join(repoPath, 'README.md'), 'fixture\n')
    git(repoPath, ['add', 'README.md'])
    git(repoPath, ['commit', '--quiet', '-m', 'fixture'])
    git(repoPath, [
      '-c',
      'maintenance.auto=false',
      'worktree',
      'add',
      '--quiet',
      '-b',
      'stale',
      stalePath,
      'HEAD'
    ])
    await rm(stalePath, { force: true, recursive: true })
    git(repoPath, [
      '-c',
      'maintenance.auto=false',
      'worktree',
      'add',
      '--quiet',
      '-b',
      'feature',
      requestedPath,
      'HEAD'
    ])

    const listedRows = parseListedWorktrees(git(repoPath, ['worktree', 'list', '--porcelain']))
    const listed = listedRows.find((worktree) => worktree.branch === 'refs/heads/feature')
    if (!listed) {
      throw new Error('Created worktree missing from Git listing')
    }
    const staleIndex = listedRows.findIndex((worktree) => worktree.branch === 'refs/heads/stale')
    const createdIndex = listedRows.indexOf(listed)
    expect(staleIndex).toBeGreaterThanOrEqual(0)
    expect(createdIndex).toBeGreaterThan(staleIndex)
    expect(await realpath(listed.path)).toBe(await realpath(requestedPath))
    if (process.platform !== 'win32') {
      expect(listed.path).toBe(join(await realpath(canonicalRoot), 'feature'))
      expect(areWorktreePathsEqual(listed.path, requestedPath)).toBe(false)
    }
    expect(findCreatedWorktree(listedRows, requestedPath, 'feature')).toBe(listed)
  })
})

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' })
}

function parseListedWorktrees(output: string): ListedWorktree[] {
  return output
    .trim()
    .split('\n\n')
    .map((block) => {
      const pathLine = block.split('\n').find((line) => line.startsWith('worktree '))
      const branchLine = block.split('\n').find((line) => line.startsWith('branch '))
      if (!pathLine) {
        throw new Error(`Malformed Git worktree listing:\n${output}`)
      }
      return {
        path: pathLine.slice('worktree '.length),
        ...(branchLine ? { branch: branchLine.slice('branch '.length) } : {})
      }
    })
}
