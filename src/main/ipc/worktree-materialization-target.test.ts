import { mkdtemp, mkdir, writeFile, symlink, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { assertWorktreeMaterializationTarget } from './worktree-materialization-target'
import { createWorktreeCopiedPaths } from './worktree-symlinks'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('accepts missing nested directories and rejects workspace root and escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-cow-target-'))
  roots.push(root)
  await expect(
    assertWorktreeMaterializationTarget(root, join(root, 'missing', 'file'))
  ).resolves.toBeUndefined()
  await expect(assertWorktreeMaterializationTarget(root, root)).rejects.toThrow('below')
  await expect(
    assertWorktreeMaterializationTarget(root, join(root, '..', 'outside'))
  ).rejects.toThrow('below')
})

it('does not create missing parents through an existing directory link', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-cow-target-'))
  roots.push(root)
  const source = join(root, 'source')
  const target = join(root, 'target')
  const outside = join(root, 'outside')
  await mkdir(join(source, 'nested', 'missing'), { recursive: true })
  await writeFile(join(source, 'nested', 'missing', 'file'), 'private')
  await mkdir(target)
  await mkdir(outside)
  await symlink(outside, join(target, 'nested'), process.platform === 'win32' ? 'junction' : 'dir')
  await createWorktreeCopiedPaths(source, target, ['nested/missing/file'], { platform: 'win32' })
  expect(await readdir(outside)).toEqual([])
})
