import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readlink,
  symlink,
  rm,
  readdir
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, it, expect } from 'vitest'
import { createWorktreeCopiedPaths } from './worktree-symlinks'
import { formatWorktreeIncludeCopyWarning } from './worktree-include-copy-budget'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe('private copy fallback', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps relative links within the private tree',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-copy-links-'))
      roots.push(root)
      const source = join(root, 'source'),
        target = join(root, 'target')
      await mkdir(join(source, 'cache'), { recursive: true })
      await mkdir(target)
      await writeFile(join(source, 'cache', 'value'), 'original')
      await symlink('value', join(source, 'cache', 'alias'))
      expect(
        await createWorktreeCopiedPaths(source, target, ['cache'], { platform: 'win32' })
      ).toEqual([])
      expect(await readlink(join(target, 'cache', 'alias'))).toBe('value')
      await writeFile(join(target, 'cache', 'alias'), 'private')
      expect(await readFile(join(source, 'cache', 'value'), 'utf8')).toBe('original')
      expect(await readFile(join(target, 'cache', 'value'), 'utf8')).toBe('private')
    }
  )
  it('refuses recursive directory materialization before writing any files', async () => {
    const source = await mkdtemp(join(tmpdir(), 'orca-copy-recursive-'))
    roots.push(source)
    const target = join(source, 'cache', 'worktree')
    await mkdir(target, { recursive: true })
    const skipped = await createWorktreeCopiedPaths(source, target, ['cache'], {
      platform: 'win32'
    })
    expect(skipped).toEqual([{ path: 'cache', reason: 'failed' }])
    expect(await readdir(target)).toEqual([])
    const warning = formatWorktreeIncludeCopyWarning(skipped)
    expect(warning).toContain('destination was unsafe')
    expect(warning).not.toContain('would exceed')
  })
})
