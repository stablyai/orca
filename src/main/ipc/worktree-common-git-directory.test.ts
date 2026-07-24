import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Repo } from '../../shared/types'
import {
  MAX_GIT_DIRECTORY_POINTER_BYTES,
  resolveWorktreeCommonGitDirectory
} from './worktree-common-git-directory'

describe('resolveWorktreeCommonGitDirectory', () => {
  const roots: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function makeRepo(): Promise<{ repo: Repo; root: string }> {
    const root = await mkdtemp(join(tmpdir(), 'orca-common-git-dir-'))
    roots.push(root)
    const repoPath = join(root, 'checkout')
    await mkdir(repoPath)
    return { repo: { id: 'repo-1', path: repoPath } as Repo, root }
  }

  it('resolves a normal linked-worktree pointer to its common directory', async () => {
    const { repo, root } = await makeRepo()
    await writeFile(join(repo.path, '.git'), 'gitdir: ../common/.git/worktrees/checkout\n')

    await expect(resolveWorktreeCommonGitDirectory(repo)).resolves.toBe(
      resolve(root, 'common', '.git')
    )
  })

  it('rejects an oversized sparse local pointer without loading it', async () => {
    const { repo } = await makeRepo()
    const dotGitPath = join(repo.path, '.git')
    await writeFile(dotGitPath, 'x')
    await truncate(dotGitPath, MAX_GIT_DIRECTORY_POINTER_BYTES + 1)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(resolveWorktreeCommonGitDirectory(repo)).resolves.toBeNull()
  })

  it('rejects oversized provider content at the same boundary', async () => {
    const { repo } = await makeRepo()
    const readFile = vi.fn(async () => `gitdir: ${'x'.repeat(MAX_GIT_DIRECTORY_POINTER_BYTES)}\n`)

    await expect(
      resolveWorktreeCommonGitDirectory(repo, {
        stat: async () => ({ type: 'file', size: 1, mtime: 0 }),
        readFile
      })
    ).resolves.toBeNull()
    expect(readFile).toHaveBeenCalledOnce()
  })
})
