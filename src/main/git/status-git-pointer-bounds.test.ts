import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveGitDir } from './status'

describe('resolveGitDir metadata bounds', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function makeWorktree(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-resolve-git-dir-'))
    roots.push(root)
    const worktreePath = join(root, 'checkout')
    await mkdir(worktreePath)
    return worktreePath
  }

  it('preserves a normal linked-worktree pointer', async () => {
    const worktreePath = await makeWorktree()
    await writeFile(join(worktreePath, '.git'), 'gitdir: ../common/.git/worktrees/checkout\n')

    await expect(resolveGitDir(worktreePath)).resolves.toBe(
      join(worktreePath, '..', 'common', '.git', 'worktrees', 'checkout')
    )
  })

  it('falls back to the .git path for an oversized sparse pointer', async () => {
    const worktreePath = await makeWorktree()
    const dotGitPath = join(worktreePath, '.git')
    await writeFile(dotGitPath, 'x')
    await truncate(dotGitPath, 64 * 1024 + 1)

    await expect(resolveGitDir(worktreePath)).resolves.toBe(dotGitPath)
  })
})
