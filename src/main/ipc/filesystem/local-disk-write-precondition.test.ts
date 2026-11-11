import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDiskBaselineSignature } from '../../../shared/file-write/disk-baseline-signature'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import { createLocalFilesystemProvider } from '../../providers/local-filesystem-provider'
import type * as LocalRegularFileRead from './local-regular-file-read'
import type * as NodeFsPromises from 'node:fs/promises'

const fileRead = vi.hoisted(() => {
  const state: {
    understateSizeBy: number
    blockedRead: { path: string; entered: () => void; wait: Promise<void> } | null
    openError: Error | null
  } = {
    understateSizeBy: 0,
    blockedRead: null,
    openError: null
  }
  return state
})
const realpathFailure = vi.hoisted(() => {
  const state: { path: string | null } = { path: null }
  return state
})
const zeroInodes = vi.hoisted(() => {
  const state: { enabled: boolean } = { enabled: false }
  return state
})
const writeGates = vi.hoisted(
  () => new Map<string, { entered: () => void; release: Promise<void> }>()
)
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    // Some RAM/subst/network/WSL volumes cannot resolve realpath.
    realpath: async (path: string) => {
      if (path === realpathFailure.path) {
        throw Object.assign(new Error(`EIO: i/o error, realpath '${path}'`), { code: 'EIO' })
      }
      return actual.realpath(path)
    },
    // 9P and some SMB mounts expose inode zero for every file.
    stat: async (path: string, options?: { bigint?: boolean }) => {
      if (options?.bigint !== true) {
        return actual.stat(path)
      }
      const stats = await actual.stat(path, { bigint: true })
      return zeroInodes.enabled ? Object.assign(stats, { ino: 0n }) : stats
    },
    // Hold a save after comparison so competing saves must wait before checking.
    writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
      const gate = typeof args[1] === 'string' ? writeGates.get(args[1]) : undefined
      if (gate) {
        gate.entered()
        await gate.release
      }
      return actual.writeFile(...args)
    })
  }
})
vi.mock('./local-regular-file-read', async (importOriginal) => {
  const actual = await importOriginal<typeof LocalRegularFileRead>()
  return {
    ...actual,
    // Model stat observing size just before a concurrent append.
    openLocalRegularFile: async (filePath: string) => {
      if (fileRead.openError) {
        throw fileRead.openError
      }
      const blockedRead = fileRead.blockedRead
      if (blockedRead?.path === filePath) {
        blockedRead.entered()
        await blockedRead.wait
      }
      const opened = await actual.openLocalRegularFile(filePath)
      opened.stats.size -= fileRead.understateSizeBy
      return opened
    }
  }
})

let base: string

beforeEach(async () => {
  base = await mkdtemp(join(await realpath(tmpdir()), 'orca-disk-write-precondition-'))
})

afterEach(async () => {
  fileRead.understateSizeBy = 0
  fileRead.blockedRead = null
  fileRead.openError = null
  realpathFailure.path = null
  writeGates.clear()
  zeroInodes.enabled = false
  await rm(base, { recursive: true, force: true })
})

describe('local provider guarded write', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the write path reads nothing from the store; authorization is the injected stub.
  const store = {} as RuntimeStore
  const provider = () =>
    createLocalFilesystemProvider({
      requireStore: () => store,
      resolveAuthorizedPath: vi.fn(async (path: string) => path)
    })

  it('writes when disk matches and refuses without writing when it does not', async () => {
    const filePath = join(base, 'a.ts')
    await writeFile(filePath, 'original')

    await expect(
      provider().writeFileWithDiskPrecondition(filePath, 'edited', {
        expectedSignature: getDiskBaselineSignature('original')
      })
    ).resolves.toEqual({ ok: true })
    expect(await readFile(filePath, 'utf8')).toBe('edited')

    await expect(
      provider().writeFileWithDiskPrecondition(filePath, 'stale', {
        expectedSignature: getDiskBaselineSignature('original')
      })
    ).resolves.toEqual({ ok: false, diskConflict: 'changed' })
    expect(await readFile(filePath, 'utf8')).toBe('edited')

    await expect(
      provider().writeFileWithDiskPrecondition(filePath, 'edited', {
        expectedSignature: getDiskBaselineSignature('original')
      })
    ).resolves.toEqual({ ok: true, unchanged: true })
  })

  // Windows symlink creation requires elevated rights or Developer Mode.
  it.skipIf(process.platform === 'win32').each([
    ['a symlink', (target: string, alias: string) => symlink(target, alias)],
    ['a hardlink', (target: string, alias: string) => link(target, alias)]
  ])(
    'lets only one save win when two clients reach one file through %s',
    async (_label, makeAlias) => {
      const target = join(base, 'target.ts')
      const alias = join(base, 'alias.ts')
      await writeFile(target, 'original')
      await makeAlias(target, alias)
      const fromBaseline = { expectedSignature: getDiskBaselineSignature('original') }

      const results = await Promise.all([
        provider().writeFileWithDiskPrecondition(target, 'through target', fromBaseline),
        provider().writeFileWithDiskPrecondition(alias, 'through alias', fromBaseline)
      ])

      expect(results.filter((result) => result.ok)).toHaveLength(1)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'lets only one save create a missing file reached through a dangling symlink',
    async () => {
      const target = join(base, 'target.ts')
      const link = join(base, 'link.ts')
      await symlink(target, link)
      const createIfMissing = {
        expectedSignature: getDiskBaselineSignature('original'),
        allowMissing: true
      }

      const results = await Promise.all([
        provider().writeFileWithDiskPrecondition(target, 'through target', createIfMissing),
        provider().writeFileWithDiskPrecondition(link, 'through link', createIfMissing)
      ])

      expect(results.filter((result) => result.ok)).toHaveLength(1)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a guarded save through a symlink loop instead of failing',
    async () => {
      const a = join(base, 'a.ts')
      const b = join(base, 'b.ts')
      await symlink(b, a)
      await symlink(a, b)

      await expect(
        provider().writeFileWithDiskPrecondition(a, 'edited', {
          expectedSignature: getDiskBaselineSignature('original'),
          allowMissing: true
        })
      ).resolves.toEqual({ ok: false, diskConflict: 'changed' })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'resolves a relative dangling link from its real folder, not the symlinked path to it',
    async () => {
      // base/alias -> base/real/sub, and sub/link.ts -> ../target.ts, so the target is base/real/target.ts.
      await mkdir(join(base, 'real', 'sub'), { recursive: true })
      await symlink(join(base, 'real', 'sub'), join(base, 'alias'))
      await symlink('../target.ts', join(base, 'real', 'sub', 'link.ts'))
      const createIfMissing = {
        expectedSignature: getDiskBaselineSignature('original'),
        allowMissing: true
      }

      const results = await Promise.all([
        provider().writeFileWithDiskPrecondition(
          join(base, 'alias', 'link.ts'),
          'through alias',
          createIfMissing
        ),
        provider().writeFileWithDiskPrecondition(
          join(base, 'real', 'target.ts'),
          'through target',
          createIfMissing
        )
      ])

      expect(results.filter((result) => result.ok)).toHaveLength(1)
    }
  )

  it('does not resurrect a deleted file without allowMissing', async () => {
    const filePath = join(base, 'gone.ts')

    await expect(
      provider().writeFileWithDiskPrecondition(filePath, 'edited', {
        expectedSignature: getDiskBaselineSignature('original')
      })
    ).resolves.toEqual({ ok: false, diskConflict: 'missing' })
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
