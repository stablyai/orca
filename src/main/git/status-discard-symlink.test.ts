import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile, access, readFile } from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'
import { bulkDiscardChanges, discardChanges } from './status'

const tempRoots: string[] = []

async function createRepoWithOutsideDirectory(): Promise<{
  repo: string
  outsideDir: string
  outsideFile: string
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-discard-symlink-'))
  tempRoots.push(root)
  const repo = path.join(root, 'repo')
  const outsideDir = path.join(root, 'outside')
  const outsideFile = path.join(outsideDir, 'keep.txt')

  await mkdir(repo)
  await mkdir(outsideDir)
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo })
  await writeFile(path.join(repo, '.gitkeep'), '')
  execFileSync('git', ['add', '.gitkeep'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repo })
  await writeFile(outsideFile, 'outside')

  return { repo, outsideDir, outsideFile }
}

async function createDirectoryLink(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('discardChanges symlink safety', () => {
  it('rejects an untracked child path through a symlinked parent', async () => {
    const { repo, outsideDir, outsideFile } = await createRepoWithOutsideDirectory()
    await createDirectoryLink(outsideDir, path.join(repo, 'link'))

    await expect(discardChanges(repo, 'link/keep.txt')).rejects.toThrow(
      'resolves outside the worktree'
    )
    await expect(access(outsideFile)).resolves.toBeUndefined()
  })

  it('rejects bulk untracked child paths through symlinked parents before deleting anything', async () => {
    const { repo, outsideDir, outsideFile } = await createRepoWithOutsideDirectory()
    const untrackedFile = path.join(repo, 'new.txt')
    const trackedFile = path.join(repo, '.gitkeep')
    await writeFile(trackedFile, 'modified')
    await writeFile(untrackedFile, 'untracked')
    await createDirectoryLink(outsideDir, path.join(repo, 'link'))

    await expect(
      bulkDiscardChanges(repo, ['.gitkeep', 'new.txt', 'link/keep.txt'])
    ).rejects.toThrow('resolves outside the worktree')
    await expect(access(outsideFile)).resolves.toBeUndefined()
    await expect(access(untrackedFile)).resolves.toBeUndefined()
    await expect(readFile(trackedFile, 'utf8')).resolves.toBe('modified')
  })

  it('removes an untracked symlink leaf without deleting its target', async () => {
    const { repo, outsideDir, outsideFile } = await createRepoWithOutsideDirectory()
    const linkPath = path.join(repo, 'outside-link')
    await createDirectoryLink(outsideDir, linkPath)

    await discardChanges(repo, 'outside-link')

    await expect(access(linkPath)).rejects.toThrow()
    await expect(access(outsideFile)).resolves.toBeUndefined()
  })

  it('removes ignored paths selected for discard', async () => {
    const { repo } = await createRepoWithOutsideDirectory()
    await writeFile(path.join(repo, '.gitignore'), 'ignored/\n')
    execFileSync('git', ['add', '.gitignore'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'ignore ignored dir'], { cwd: repo })
    const ignoredFile = path.join(repo, 'ignored', 'file.txt')
    await mkdir(path.dirname(ignoredFile))
    await writeFile(ignoredFile, 'ignored')

    await discardChanges(repo, 'ignored')

    await expect(access(path.join(repo, 'ignored'))).rejects.toThrow()
  })

  it('removes untracked nested git repos selected for discard', async () => {
    const { repo } = await createRepoWithOutsideDirectory()
    const nestedRepo = path.join(repo, 'nested')
    await mkdir(nestedRepo)
    execFileSync('git', ['init', '-q'], { cwd: nestedRepo })
    await writeFile(path.join(nestedRepo, 'file.txt'), 'nested')

    await discardChanges(repo, 'nested')

    await expect(access(nestedRepo)).rejects.toThrow()
  })
})
