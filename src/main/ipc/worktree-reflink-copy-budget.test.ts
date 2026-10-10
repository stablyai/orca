import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultReflinkCloneDeps, type ReflinkCloneDeps } from './worktree-reflink-clone'
import { createWorktreeCopiedPaths } from './worktree-symlinks'

// A successful probe is injected; real Node/cp clones then encounter non-reflinkable tmpfs files.
describe.skipIf(process.platform !== 'linux' || !existsSync('/dev/shm'))(
  'reflink copy budget after a successful probe',
  () => {
    let root: string
    let otherFilesystem: string
    let primary: string
    let worktree: string
    let deps: ReflinkCloneDeps

    beforeEach(() => {
      root = mkdtempSync('/dev/shm/orca-reflink-budget-')
      otherFilesystem = mkdtempSync(join(tmpdir(), 'orca-reflink-target-'))
      primary = join(root, 'primary')
      worktree = join(root, 'worktree')
      mkdirSync(primary)
      mkdirSync(worktree)
      deps = {
        ...defaultReflinkCloneDeps,
        reflinkFileOrFail: vi.fn(async (source, target) => copyFileSync(source, target))
      }
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
      rmSync(root, { recursive: true, force: true })
      rmSync(otherFilesystem, { recursive: true, force: true })
    })

    const copyPaths = (paths: string[]) =>
      createWorktreeCopiedPaths(primary, worktree, paths, {
        platform: 'linux',
        reflinkCloneDeps: deps,
        copyBudget: { maxBytes: 64, maxEntries: 100 }
      })

    it
      .skipIf(!existsSync('/dev/shm') || statSync('/dev/shm').dev === statSync(tmpdir()).dev)
      .each([40, 128])(
      'charges unavailable clones on a different target filesystem (%i bytes)',
      async (size) => {
        mkdirSync(join(primary, 'nested'))
        symlinkSync(otherFilesystem, join(worktree, 'nested'))
        writeFileSync(join(primary, 'nested', 'one'), 'a'.repeat(size))
        writeFileSync(join(primary, 'nested', 'two'), 'b'.repeat(size))
        deps.reflinkFileOrFail = vi.fn(async (source, target) => {
          if (dirname(target) === worktree) {
            copyFileSync(source, target)
            return
          }
          await defaultReflinkCloneDeps.reflinkFileOrFail(source, target)
        })

        const skipped = await copyPaths(['nested/one', 'nested/two'])

        expect(skipped).toEqual(
          size > 64
            ? [
                { path: 'nested/one', reason: 'bytes' },
                { path: 'nested/two', reason: 'bytes' }
              ]
            : [{ path: 'nested/two', reason: 'bytes' }]
        )
        expect(readdirSync(otherFilesystem)).toEqual(size > 64 ? [] : ['one'])
        if (size <= 64) {
          expect(readFileSync(join(otherFilesystem, 'one'), 'utf8')).toBe('a'.repeat(size))
        }
        expect(deps.reflinkFileOrFail).toHaveBeenCalledTimes(2)
      }
    )

    it('refuses an uncloneable file over budget without publishing a destination', async () => {
      writeFileSync(join(primary, 'large'), 'x'.repeat(128))

      expect(await copyPaths(['large'])).toEqual([{ path: 'large', reason: 'bytes' }])
      expect(readdirSync(worktree)).toEqual([])
      expect(readFileSync(join(primary, 'large'), 'utf8')).toBe('x'.repeat(128))
      expect(deps.reflinkFileOrFail).toHaveBeenCalledTimes(1)
    })

    it('charges file fallbacks cumulatively when later sources reuse the probe', async () => {
      writeFileSync(join(primary, 'one'), 'a'.repeat(40))
      writeFileSync(join(primary, 'two'), 'b'.repeat(40))

      expect(await copyPaths(['one', 'two'])).toEqual([{ path: 'two', reason: 'bytes' }])
      expect(readFileSync(join(worktree, 'one'), 'utf8')).toBe('a'.repeat(40))
      expect(readdirSync(worktree)).toEqual(['one'])
      expect(deps.reflinkFileOrFail).toHaveBeenCalledTimes(1)
    })

    it('reports a partial tree and refuses its uncloneable payload over budget', async () => {
      mkdirSync(join(primary, 'tree'))
      writeFileSync(join(primary, 'tree', 'kept'), 'original')
      writeFileSync(join(primary, 'tree', 'payload'), 'x'.repeat(128))
      chmodSync(join(primary, 'tree'), 0o700)
      deps.reflinkTree = async (source, target) => {
        // The reservation may already contain a completed clone or a raced user file.
        writeFileSync(join(target, 'kept'), 'preserved')
        await defaultReflinkCloneDeps.reflinkTree(source, target)
      }

      expect(await copyPaths(['tree'])).toEqual([
        { path: 'tree', reason: 'bytes', mayBePartial: true }
      ])
      expect(readdirSync(join(worktree, 'tree'))).toEqual(['kept'])
      expect(statSync(join(worktree, 'tree')).mode & 0o777).toBe(0o700)
      expect(readFileSync(join(worktree, 'tree', 'kept'), 'utf8')).toBe('preserved')
      expect(readFileSync(join(primary, 'tree', 'payload'), 'utf8')).toBe('x'.repeat(128))
    })

    it('completes a budgeted partial-tree fallback without clobbering and charges later paths', async () => {
      mkdirSync(join(primary, 'tree'))
      writeFileSync(join(primary, 'tree', 'kept'), 'original')
      writeFileSync(join(primary, 'tree', 'payload'), 'a'.repeat(40))
      writeFileSync(join(primary, 'later'), 'b'.repeat(40))
      deps.reflinkTree = async (source, target) => {
        writeFileSync(join(target, 'kept'), 'preserved')
        await defaultReflinkCloneDeps.reflinkTree(source, target)
      }

      expect(await copyPaths(['tree', 'later'])).toEqual([{ path: 'later', reason: 'bytes' }])
      expect(readFileSync(join(worktree, 'tree', 'kept'), 'utf8')).toBe('preserved')
      expect(readFileSync(join(worktree, 'tree', 'payload'), 'utf8')).toBe('a'.repeat(40))
      expect(existsSync(join(worktree, 'later'))).toBe(false)
      expect(deps.reflinkFileOrFail).toHaveBeenCalledTimes(1)
    })
  }
)
