import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDiskBaselineSignature } from '../../../shared/disk-baseline-signature'
import type { RuntimeStore } from '../../runtime/runtime-store-contract'
import { createLocalFilesystemProvider } from '../../providers/local-filesystem-provider'
import {
  checkLocalDiskWritePrecondition,
  diskSignatureOfUtf8
} from './local-disk-write-precondition'
import type * as LocalRegularFileRead from './local-regular-file-read'
import type * as NodeFsPromises from 'node:fs/promises'

const fileRead = vi.hoisted(() => {
  const state: { understateSizeBy: number; hangPath: string | null; openError: Error | null } = {
    understateSizeBy: 0,
    hangPath: null,
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
    // Why: some volumes (RAM disks, subst and network drives, WSL UNC) fail realpath outright.
    realpath: async (path: string) => {
      if (path === realpathFailure.path) {
        throw Object.assign(new Error(`EIO: i/o error, realpath '${path}'`), { code: 'EIO' })
      }
      return actual.realpath(path)
    },
    // Why: 9P and some SMB mounts report inode 0 for every file.
    stat: async (path: string, options?: { bigint?: boolean }) => {
      if (options?.bigint !== true) {
        return actual.stat(path)
      }
      const stats = await actual.stat(path, { bigint: true })
      return zeroInodes.enabled ? Object.assign(stats, { ino: 0n }) : stats
    },
    // Why: holds one save between its passed check and its write, where a competing save must wait.
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const gate = typeof args[1] === 'string' ? writeGates.get(args[1]) : undefined
      if (gate) {
        gate.entered()
        await gate.release
      }
      return actual.writeFile(...args)
    }
  }
})
vi.mock('./local-regular-file-read', async (importOriginal) => {
  const actual = await importOriginal<typeof LocalRegularFileRead>()
  return {
    ...actual,
    // Why: reports the size from before a concurrent append, as a stat racing the writer would.
    openLocalRegularFile: async (filePath: string) => {
      if (fileRead.openError) {
        throw fileRead.openError
      }
      if (filePath === fileRead.hangPath) {
        // A read stuck on a dead network or WSL mount.
        await new Promise(() => undefined)
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
  fileRead.hangPath = null
  fileRead.openError = null
  realpathFailure.path = null
  writeGates.clear()
  zeroInodes.enabled = false
  await rm(base, { recursive: true, force: true })
})

describe('checkLocalDiskWritePrecondition', () => {
  it('passes when disk still holds the baseline content', async () => {
    const filePath = join(base, 'a.ts')
    const content = 'const café = "☕ 𝄞"\n'
    await writeFile(filePath, content)

    await expect(
      checkLocalDiskWritePrecondition(filePath, {
        expectedSignature: getDiskBaselineSignature(content)
      })
    ).resolves.toBeNull()
  })

  it('reports a same-size external rewrite as changed', async () => {
    const filePath = join(base, 'a.ts')
    await writeFile(filePath, 'agent')

    await expect(
      checkLocalDiskWritePrecondition(filePath, {
        expectedSignature: getDiskBaselineSignature('human')
      })
    ).resolves.toBe('changed')
  })

  it('reports a size the baseline cannot decode to as changed', async () => {
    const filePath = join(base, 'a.ts')
    await writeFile(filePath, 'x'.repeat(100))

    await expect(
      checkLocalDiskWritePrecondition(filePath, {
        expectedSignature: getDiskBaselineSignature('short')
      })
    ).resolves.toBe('changed')
  })

  it('reports a file that grew past the baseline after its size check as changed', async () => {
    const filePath = join(base, 'a.ts')
    await writeFile(filePath, `ab${'x'.repeat(10)}`)
    fileRead.understateSizeBy = 10

    await expect(
      checkLocalDiskWritePrecondition(filePath, {
        expectedSignature: getDiskBaselineSignature('ab')
      })
    ).resolves.toBe('changed')
  })

  it('reports a missing file unless the caller allows recreating it', async () => {
    const filePath = join(base, 'gone.ts')
    const expectedSignature = getDiskBaselineSignature('was here')

    await expect(checkLocalDiskWritePrecondition(filePath, { expectedSignature })).resolves.toBe(
      'missing'
    )
    await expect(
      checkLocalDiskWritePrecondition(filePath, { expectedSignature, allowMissing: true })
    ).resolves.toBeNull()
  })
})

describe('sliced disk hashing', () => {
  it('matches the whole-file signature across slice boundaries and invalid bytes', async () => {
    const slice = 1024 * 1024
    // A 4-byte character straddles the first slice edge, followed by bytes that are not UTF-8.
    const text = Buffer.from(`${'a'.repeat(slice - 2)}𝄞 tail é`, 'utf8')
    const buffer = Buffer.concat([text, Buffer.from([0xff, 0xc3, 0x28, 0xe2, 0x82]), text])

    await expect(diskSignatureOfUtf8(buffer)).resolves.toBe(
      getDiskBaselineSignature(buffer.toString('utf8'))
    )
  })
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
  })

  it('lets only one of two concurrent saves from the same baseline write', async () => {
    const filePath = join(base, 'a.ts')
    await writeFile(filePath, 'original')
    const fromBaseline = { expectedSignature: getDiskBaselineSignature('original') }

    const results = await Promise.all([
      provider().writeFileWithDiskPrecondition(filePath, 'client one', fromBaseline),
      provider().writeFileWithDiskPrecondition(filePath, 'client two', fromBaseline)
    ])

    const winner = results.findIndex((result) => result.ok)
    expect(results[1 - winner]).toEqual({ ok: false, diskConflict: 'changed' })
    expect(await readFile(filePath, 'utf8')).toBe(winner === 0 ? 'client one' : 'client two')
  })

  // Why: creating symlinks needs elevated rights on Windows runners.
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

  it('does not chain unrelated files on a volume that reports inode 0', async () => {
    const stuck = join(base, 'stuck.ts')
    const other = join(base, 'other.ts')
    await writeFile(stuck, 'original')
    await writeFile(other, 'original')
    zeroInodes.enabled = true
    fileRead.hangPath = stuck
    const fromBaseline = { expectedSignature: getDiskBaselineSignature('original') }

    void provider().writeFileWithDiskPrecondition(stuck, 'edited', fromBaseline)
    const outcome = await Promise.race([
      provider().writeFileWithDiskPrecondition(other, 'edited', fromBaseline),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 1_000))
    ])

    expect(outcome).toEqual({ ok: true })
  })

  it('keeps saves ordered when a queued restore creates the file mid-queue', async () => {
    const filePath = join(base, 'restored.ts')
    const fromRestored = { expectedSignature: getDiskBaselineSignature('restored') }
    const gateWrite = (content: string) => {
      let entered: () => void = () => undefined
      let release: () => void = () => undefined
      const reached = new Promise<void>((resolve) => {
        entered = resolve
      })
      writeGates.set(content, {
        entered,
        release: new Promise<void>((resolve) => {
          release = resolve
        })
      })
      return { reached, release: () => release() }
    }
    const restoreGate = gateWrite('restored')
    const saveBGate = gateWrite('save B')

    // The restore holds the lock while the file is still missing, so B queues on its path.
    const restore = provider().writeFileWithDiskPrecondition(filePath, 'restored', {
      ...fromRestored,
      allowMissing: true
    })
    await restoreGate.reached
    const saveB = provider().writeFileWithDiskPrecondition(filePath, 'save B', fromRestored)
    await new Promise((resolve) => setTimeout(resolve, 20))
    restoreGate.release()
    await saveBGate.reached
    // C arrives once the file exists, so an inode-only key would let it race B.
    const saveC = provider().writeFileWithDiskPrecondition(filePath, 'save C', fromRestored)
    await new Promise((resolve) => setTimeout(resolve, 50))
    saveBGate.release()

    const results = await Promise.all([restore, saveB, saveC])
    expect(results.slice(0, 2)).toEqual([{ ok: true }, { ok: true }])
    expect(results[2]).toEqual({ ok: false, diskConflict: 'changed' })
    expect(await readFile(filePath, 'utf8')).toBe('save B')
  })

  it('still saves where the folder cannot be resolved to a real path', async () => {
    const filePath = join(base, 'new.ts')
    realpathFailure.path = base

    await expect(
      provider().writeFileWithDiskPrecondition(filePath, 'created', {
        expectedSignature: getDiskBaselineSignature('anything'),
        allowMissing: true
      })
    ).resolves.toEqual({ ok: true })
    expect(await readFile(filePath, 'utf8')).toBe('created')
  })

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
    'lets only one save create a missing file at the end of a 20-link dangling chain',
    async () => {
      const target = join(base, 'target.ts')
      let previous = target
      for (let index = 0; index < 20; index += 1) {
        const link = join(base, `link-${index}.ts`)
        await symlink(previous, link)
        previous = link
      }
      const createIfMissing = {
        expectedSignature: getDiskBaselineSignature('original'),
        allowMissing: true
      }

      const results = await Promise.all([
        provider().writeFileWithDiskPrecondition(target, 'through target', createIfMissing),
        provider().writeFileWithDiskPrecondition(previous, 'through chain', createIfMissing)
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

  it('does not hold up a save to another file in the folder behind a stuck read', async () => {
    const stuck = join(base, 'stuck.ts')
    const other = join(base, 'other.ts')
    await writeFile(stuck, 'original')
    await writeFile(other, 'original')
    fileRead.hangPath = stuck
    const fromBaseline = { expectedSignature: getDiskBaselineSignature('original') }

    void provider().writeFileWithDiskPrecondition(stuck, 'edited', fromBaseline)
    const otherSave = provider().writeFileWithDiskPrecondition(other, 'edited', fromBaseline)
    const outcome = await Promise.race([
      otherSave,
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 1_000))
    ])

    expect(outcome).toEqual({ ok: true })
  })

  it('writes a save with no precondition directly, not queued behind a stuck guarded save', async () => {
    const filePath = join(base, 'stuck.ts')
    await writeFile(filePath, 'original')
    fileRead.hangPath = filePath

    void provider().writeFileWithDiskPrecondition(filePath, 'guarded', {
      expectedSignature: getDiskBaselineSignature('original')
    })
    const plainSave = provider().writeFileWithDiskPrecondition(filePath, 'plain', undefined)
    const outcome = await Promise.race([
      plainSave,
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 1_000))
    ])

    expect(outcome).toEqual({ ok: true })
    expect(await readFile(filePath, 'utf-8')).toBe('plain')
  })

  it('does not read a permission error whose path names ENOENT as a missing file', async () => {
    const filePath = join(base, 'locked.ts')
    fileRead.openError = Object.assign(
      new Error(`EACCES: permission denied, open '${base}/ENOENT: no such file or directory.ts'`),
      { code: 'EACCES' }
    )

    await expect(
      checkLocalDiskWritePrecondition(filePath, {
        expectedSignature: getDiskBaselineSignature('original'),
        allowMissing: true
      })
    ).rejects.toThrow('EACCES')
  })

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
