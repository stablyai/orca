import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveFormatTarget } from './format-on-save-file-containment'

let sandbox: string
let worktree: string
let outside: string

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'format-on-save-containment-')))
  worktree = join(sandbox, 'repo')
  outside = join(sandbox, 'outside')
  mkdirSync(join(worktree, 'src'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(worktree, 'src', 'a.ts'), '')
  writeFileSync(join(outside, 'secret.ts'), '')
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

const resolveLocal = (absoluteFilePath: string) =>
  resolveFormatTarget({ worktreePath: worktree, absoluteFilePath, isRemote: false })

describe('resolveFormatTarget', () => {
  it('returns the canonical path and worktree-relative path for a file inside', async () => {
    await expect(resolveLocal(join(worktree, 'src', 'a.ts'))).resolves.toEqual({
      absolutePath: join(worktree, 'src', 'a.ts'),
      relativePath: 'src/a.ts'
    })
  })

  it('rejects a path that climbs out with dot-dot segments', async () => {
    await expect(resolveLocal(`${worktree}/../outside/secret.ts`)).resolves.toBeNull()
    await expect(resolveLocal(`${worktree}/src/../../outside/secret.ts`)).resolves.toBeNull()
    await expect(
      resolveFormatTarget({
        worktreePath: '/home/dev/repo',
        absoluteFilePath: '/home/dev/repo/../other/a.ts',
        isRemote: true
      })
    ).resolves.toBeNull()
  })

  it('keeps a not-yet-existing file inside the worktree', async () => {
    await expect(resolveLocal(join(worktree, 'src', 'new', 'b.ts'))).resolves.toEqual({
      absolutePath: join(worktree, 'src', 'new', 'b.ts'),
      relativePath: 'src/new/b.ts'
    })
  })

  it('returns a wholly missing path unchanged', async () => {
    const missingRoot = join(sandbox, 'missing-repo')
    await expect(
      resolveFormatTarget({
        worktreePath: missingRoot,
        absoluteFilePath: join(missingRoot, 'src', 'a.ts'),
        isRemote: false
      })
    ).resolves.toEqual({
      absolutePath: join(missingRoot, 'src', 'a.ts'),
      relativePath: 'src/a.ts'
    })
  })

  it('treats a remote path lexically without touching the local filesystem', async () => {
    await expect(
      resolveFormatTarget({
        worktreePath: '/home/dev/repo',
        absoluteFilePath: '/home/dev/repo/src/a.ts',
        isRemote: true
      })
    ).resolves.toEqual({ absolutePath: '/home/dev/repo/src/a.ts', relativePath: 'src/a.ts' })
  })

  describe.skipIf(process.platform === 'win32')('symlinks', () => {
    it('rejects a file reached through a directory symlink that leaves the worktree', async () => {
      symlinkSync(outside, join(worktree, 'link'))
      await expect(resolveLocal(join(worktree, 'link', 'secret.ts'))).resolves.toBeNull()
    })

    it('rejects a file symlink that points outside the worktree', async () => {
      symlinkSync(join(outside, 'secret.ts'), join(worktree, 'src', 'alias.ts'))
      await expect(resolveLocal(join(worktree, 'src', 'alias.ts'))).resolves.toBeNull()
    })

    it('follows a symlink that stays inside and reports the real target', async () => {
      symlinkSync(join(worktree, 'src', 'a.ts'), join(worktree, 'alias.ts'))
      await expect(resolveLocal(join(worktree, 'alias.ts'))).resolves.toEqual({
        absolutePath: join(worktree, 'src', 'a.ts'),
        relativePath: 'src/a.ts'
      })
    })

    it('accepts a worktree that is itself reached through a symlink', async () => {
      const viaLink = join(sandbox, 'repo-link')
      symlinkSync(worktree, viaLink)
      await expect(
        resolveFormatTarget({
          worktreePath: viaLink,
          absoluteFilePath: join(viaLink, 'src', 'a.ts'),
          isRemote: false
        })
      ).resolves.toEqual({
        absolutePath: join(worktree, 'src', 'a.ts'),
        relativePath: 'src/a.ts'
      })
    })
  })
})
