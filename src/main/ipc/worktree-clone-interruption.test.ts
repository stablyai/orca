import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cloneWorktreePathWithApfs } from './worktree-apfs-clone'
import { WorktreeCloneInterruptedError } from './worktree-clone-copy-errors'
import { createWorktreeCopiedPaths, createWorktreeLinkedPaths } from './worktree-symlinks'
import { formatWorktreeIncludeCopyWarning } from './worktree-include-copy-budget'
import { cloneWorktreePathWithReflink, type ReflinkCloneDeps } from './worktree-reflink-clone'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(): Promise<{ source: string; target: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-cow-interruption-'))
  roots.push(root)
  const source = join(root, 'source')
  const target = join(root, 'target')
  await mkdir(source)
  await mkdir(target)
  await writeFile(join(source, 'payload'), 'original')
  return { source, target }
}

describe('interrupted worktree clones', () => {
  it.each(['exited', 'unverifiable'] as const)(
    'never falls back when termination is %s',
    async (termination) => {
      const { source, target } = await fixture()
      const options = {
        platform: 'linux' as const,
        cloneWorktreePath: async () => {
          throw new WorktreeCloneInterruptedError(termination)
        }
      }
      const skipped = [
        { path: 'payload', reason: 'interrupted' as const, mayBePartial: true, termination }
      ]
      if (termination === 'unverifiable') {
        await expect(
          createWorktreeCopiedPaths(source, target, ['payload'], options)
        ).rejects.toMatchObject({ termination })
      } else {
        expect(await createWorktreeCopiedPaths(source, target, ['payload'], options)).toEqual(
          skipped
        )
      }
      await expect(
        createWorktreeLinkedPaths(source, target, ['payload'], options)
      ).rejects.toMatchObject({ termination })
      expect(await readdir(target)).toEqual([])
      const warning = formatWorktreeIncludeCopyWarning(skipped)
      expect(warning).toContain('was interrupted')
      expect(warning).not.toContain('would exceed')
      if (termination === 'unverifiable') {
        expect(warning).toContain('copying may still be running')
        expect(warning).not.toContain('in manually')
      }
    }
  )

  it.each(['exited', 'unverifiable'] as const)(
    'cleans staging only after confirmed exit (%s)',
    async (termination) => {
      const { source, target } = await fixture()
      const deps: ReflinkCloneDeps = {
        reflinkFileOrFail: async () => {},
        reflinkFile: async () => {},
        reflinkTree: async (_source, staged) => {
          await writeFile(join(staged, 'partial'), '')
          throw new WorktreeCloneInterruptedError(termination)
        },
        publishTree: async () => {
          throw new Error('must not publish')
        }
      }
      await expect(
        cloneWorktreePathWithReflink(source, join(target, 'copy'), true, deps)
      ).rejects.toMatchObject({ termination })
      const entries = await readdir(target)
      if (termination === 'exited') {
        expect(entries).toEqual([])
      } else {
        expect(entries).toContain('copy')
        expect(entries.some((entry) => entry.startsWith('.orca-reflink-stage-'))).toBe(true)
      }
    }
  )
  it.each(['exited', 'unverifiable'] as const)(
    'retains APFS staging when termination is %s',
    async (termination) => {
      const { source, target } = await fixture()
      await expect(
        cloneWorktreePathWithApfs(source, join(target, 'copy'), true, {
          execFileAsync: async (_file, args) => {
            if (args[0] === 'probe') {
              return { stdout: '', stderr: '' }
            }
            if (args[0] !== 'clone') {
              throw new Error('must not publish')
            }
            await mkdir(args[2])
            await writeFile(join(args[2], 'partial'), '')
            throw new WorktreeCloneInterruptedError(termination)
          }
        })
      ).rejects.toMatchObject({ termination })
      const entries = await readdir(target)
      expect(entries.some((entry) => entry.startsWith('.orca-apfs-stage-'))).toBe(
        termination === 'unverifiable'
      )
    }
  )
})
