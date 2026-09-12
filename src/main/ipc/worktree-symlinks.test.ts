import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  statSync,
  lstatSync,
  readlinkSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync,
  chmodSync,
  renameSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWorktreeCopiedPaths,
  createWorktreeLinkedPaths,
  createWorktreeSharedPaths,
  worktreeSymlinkTypeCandidates,
  findExistingWorktreeSymlinkPaths,
  removeWorktreeLinkedPaths,
  removeWorktreeSymlinks
} from './worktree-symlinks'

import { WorktreeLinkedPathTargetExistsError } from './worktree-clone-copy-errors'

type WorktreeLinkedPathOptionsForTest = NonNullable<Parameters<typeof createWorktreeLinkedPaths>[3]>
type ApfsCloneDepsForTest = NonNullable<WorktreeLinkedPathOptionsForTest['apfsCloneDeps']>
type ReflinkCloneDepsForTest = NonNullable<WorktreeLinkedPathOptionsForTest['reflinkCloneDeps']>
const posixIt = process.platform === 'win32' ? it.skip : it

function notSupported(): never {
  throw Object.assign(new Error('ENOTSUP: operation not supported'), { code: 'ENOTSUP' })
}

/** A stand-in reflink backend. `supported: false` answers the probe the way
 *  ext4 and tmpfs do; `supported: true` copies bytes instead of sharing them,
 *  which nothing above the backend can tell apart from a real reflink. Linux
 *  tests inject one or the other so the host's own /tmp filesystem never
 *  decides the outcome. */
function createReflinkCloneDeps(options: {
  supported: boolean
  onReflink?: (source: string, target: string) => void
}): ReflinkCloneDepsForTest {
  return {
    reflinkFileOrFail: vi.fn(async (source: string, target: string) => {
      if (!options.supported) {
        notSupported()
      }
      copyFileSync(source, target)
    }),
    reflinkFile: vi.fn(async (source: string, target: string) => {
      options.onReflink?.(source, target)
      copyFileSync(source, target)
    }),
    reflinkTree: vi.fn(async (source: string, target: string) => {
      options.onReflink?.(source, target)
      cpSync(source, target, { recursive: true, force: false, errorOnExist: false })
    }),
    publishTree: async (source, target) => {
      cpSync(source, target, { recursive: true, force: false, errorOnExist: false })
    }
  }
}

function createApfsCloneDeps(options: {
  onClone?: (args: readonly string[]) => void
  onProbe?: () => void
}): ApfsCloneDepsForTest {
  const execFileAsync = vi.fn<ApfsCloneDepsForTest['execFileAsync']>(async (_file, args) => {
    const [command, source, target] = args
    if (command === 'probe') {
      options.onProbe?.()
    } else if (command === 'clone') {
      cpSync(source, target, { recursive: true, force: false, errorOnExist: true })
      chmodSync(target, statSync(source).mode & 0o777)
      options.onClone?.(args)
    } else if (command === 'publish') {
      if (existsSync(target)) {
        throw new WorktreeLinkedPathTargetExistsError(target)
      }
      renameSync(source, target)
    } else {
      throw new Error(`Unexpected native clone operation: ${command}`)
    }
    return { stdout: '', stderr: '' }
  })
  return { execFileAsync }
}

describe('createWorktreeLinkedPaths', () => {
  let root: string
  let primary: string
  let worktree: string
  let warn: ReturnType<typeof vi.spyOn>
  let error: ReturnType<typeof vi.spyOn>
  // Link mode on a Linux filesystem that cannot reflink: the symlink path.
  const linkOnLinux = (paths: readonly string[]): Promise<void> =>
    createWorktreeLinkedPaths(primary, worktree, paths, {
      platform: 'linux',
      reflinkCloneDeps: createReflinkCloneDeps({ supported: false })
    })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-symlinks-'))
    primary = join(root, 'primary')
    worktree = join(root, 'worktree')
    mkdirSync(primary, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    error.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  it('symlinks a file from primary into the worktree at the same relative path', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    await linkOnLinux(['.env'])

    const linkStat = lstatSync(join(worktree, '.env'))
    expect(linkStat.isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(worktree, '.env'))).toBe(join(primary, '.env'))
    // Following the link yields the primary's contents.
    expect(statSync(join(worktree, '.env')).isFile()).toBe(true)
  })

  it('symlinks a directory from primary into the worktree', async () => {
    mkdirSync(join(primary, 'node_modules'))
    writeFileSync(join(primary, 'node_modules', 'marker'), 'installed')
    await linkOnLinux(['node_modules'])

    expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(statSync(join(worktree, 'node_modules', 'marker')).isFile()).toBe(true)
  })

  it('creates parent directories lazily for nested paths', async () => {
    mkdirSync(join(primary, 'apps', 'web'), { recursive: true })
    writeFileSync(join(primary, 'apps', 'web', '.env'), 'X=1\n')
    await linkOnLinux(['apps/web/.env'])

    expect(lstatSync(join(worktree, 'apps', 'web', '.env')).isSymbolicLink()).toBe(true)
  })

  it('skips entries whose source is missing in the primary checkout', async () => {
    await linkOnLinux(['node_modules'])
    // No link created, no throw.
    expect(() => lstatSync(join(worktree, 'node_modules'))).toThrow()
    expect(error).not.toHaveBeenCalled()
  })

  it('preserves a pre-existing target in the worktree (no clobber)', async () => {
    writeFileSync(join(primary, '.env'), 'FROM_PRIMARY=1\n')
    writeFileSync(join(worktree, '.env'), 'FROM_WORKTREE=1\n')

    await linkOnLinux(['.env'])

    // The pre-existing regular file stays; no symlink was created.
    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(false)
    expect(statSync(join(worktree, '.env')).isFile()).toBe(true)
  })

  it('does not escape the primary checkout via a leading-slash path', async () => {
    // Why: the helper strips leading slashes (so `/etc/passwd` becomes the
    // relative `etc/passwd`). No file is created outside the worktree, and the
    // resolved source — which falls inside `primary/etc/passwd` — is missing,
    // so the entry is silently skipped rather than linking to `/etc/passwd`.
    await linkOnLinux(['/etc/passwd'])

    expect(() => lstatSync(join(worktree, 'etc', 'passwd'))).toThrow()
    expect(error).not.toHaveBeenCalled()
  })

  it('rejects parent-directory traversal', async () => {
    await linkOnLinux(['../secrets'])

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[worktree-symlinks] Skipping unsafe path "../secrets"')
    )
  })

  it('rejects nested traversal via ..', async () => {
    await linkOnLinux(['safe/../../escape'])

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[worktree-symlinks] Skipping unsafe path "safe/../../escape"')
    )
  })

  it('rejects traversal using backslash separators (Windows form)', async () => {
    // Why: users configuring paths on Windows (or pasting a mixed-separator
    // value) could bypass a POSIX-only split. The guard normalizes across
    // `/` and `\` so `..\escape` and `foo\..\..\escape` both get rejected.
    await linkOnLinux(['..\\escape'])
    await linkOnLinux(['foo\\..\\..\\escape'])

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[worktree-symlinks] Skipping unsafe path "..\\escape"')
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[worktree-symlinks] Skipping unsafe path "foo\\..\\..\\escape"')
    )
  })

  it('strips a leading slash then treats the remainder as a relative path', async () => {
    writeFileSync(join(primary, '.env'), 'X=1\n')
    await linkOnLinux(['/.env'])

    // Leading slash is stripped in the helper; the remaining `.env` is a valid relative path.
    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('skips empty and whitespace-only entries', async () => {
    // The helper logs an "unsafe path" warn for these; nothing gets linked.
    await linkOnLinux(['', '   '])
    expect(error).not.toHaveBeenCalled()
  })

  it('continues processing later entries after one fails', async () => {
    writeFileSync(join(primary, '.env'), 'X=1\n')
    writeFileSync(join(primary, 'config.json'), '{}')

    await linkOnLinux([
      '../escape', // rejected
      'missing-source', // no source, skipped
      '.env', // succeeds
      'config.json' // succeeds
    ])

    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(worktree, 'config.json')).isSymbolicLink()).toBe(true)
  })

  it('is a no-op for an empty paths list', async () => {
    await linkOnLinux([])
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('uses APFS clone-copy for configured paths on macOS', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    const cloneWorktreePath = vi.fn(async (_source: string, target: string) => {
      writeFileSync(target, 'SECRET=1\n')
    })

    await createWorktreeLinkedPaths(primary, worktree, ['.env'], {
      platform: 'darwin',
      cloneWorktreePath
    })

    expect(cloneWorktreePath).toHaveBeenCalledWith(
      join(primary, '.env'),
      join(worktree, '.env'),
      false
    )
    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(false)
    expect(statSync(join(worktree, '.env')).isFile()).toBe(true)
  })

  it('does not overwrite a file target that appears before APFS clone-copy is published', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    const target = join(worktree, '.env')
    const deps = createApfsCloneDeps({
      onClone: (args) => {
        const tempTarget = args.at(-1)
        if (!tempTarget) {
          throw new Error('Missing APFS clone temp target')
        }
        writeFileSync(tempTarget, 'SECRET=1\n')
        writeFileSync(target, 'RACE=1\n')
      }
    })

    await createWorktreeLinkedPaths(primary, worktree, ['.env'], {
      platform: 'darwin',
      apfsCloneDeps: deps
    })

    expect(readFileSync(target, 'utf8')).toBe('RACE=1\n')
    expect(existsSync(join(worktree, '.orca-apfs-clone-file-race'))).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('does not replace a directory target that appears before APFS clone-copy reserves it', async () => {
    mkdirSync(join(primary, 'node_modules'))
    writeFileSync(join(primary, 'node_modules', 'primary-marker'), 'PRIMARY\n')
    const target = join(worktree, 'node_modules')
    let createdRacedTarget = false
    const deps = createApfsCloneDeps({
      onProbe: () => {
        if (!createdRacedTarget) {
          createdRacedTarget = true
          mkdirSync(target)
          writeFileSync(join(target, 'user-marker'), 'USER\n')
        }
      },
      onClone: () => {
        throw new Error('APFS clone-copy should not run after the target appears')
      }
    })

    await createWorktreeLinkedPaths(primary, worktree, ['node_modules'], {
      platform: 'darwin',
      apfsCloneDeps: deps
    })

    expect(readFileSync(join(target, 'user-marker'), 'utf8')).toBe('USER\n')
    expect(existsSync(join(target, 'primary-marker'))).toBe(false)
    expect(
      vi.mocked(deps.execFileAsync).mock.calls.filter(([, args]) => args[0] === 'clone')
    ).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('does not overwrite or remove a nested target after APFS clone-copy hits a conflict', async () => {
    const source = join(primary, 'node_modules')
    mkdirSync(source)
    writeFileSync(join(primary, 'node_modules', 'primary-marker'), 'PRIMARY\n')
    const target = join(worktree, 'node_modules')
    let cpArgs: readonly string[] | undefined
    const deps = createApfsCloneDeps({
      onClone: (args) => {
        cpArgs = args
        mkdirSync(target)
        writeFileSync(join(target, 'primary-marker'), 'USER\n')
      }
    })

    await createWorktreeLinkedPaths(primary, worktree, ['node_modules'], {
      platform: 'darwin',
      apfsCloneDeps: deps
    })

    expect(cpArgs).toEqual(['clone', source, expect.stringContaining('.orca-apfs-stage-')])
    expect(readFileSync(join(target, 'primary-marker'), 'utf8')).toBe('USER\n')
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  posixIt('preserves the source directory mode after APFS clone-copy reserves it', async () => {
    const source = join(primary, 'node_modules')
    mkdirSync(source)
    chmodSync(source, 0o700)
    const target = join(worktree, 'node_modules')
    const deps = createApfsCloneDeps({
      onClone: (args) => {
        writeFileSync(join(args[2], 'marker'), 'CLONED\n')
      }
    })

    await createWorktreeLinkedPaths(primary, worktree, ['node_modules'], {
      platform: 'darwin',
      apfsCloneDeps: deps
    })

    expect(statSync(target).mode & 0o777).toBe(0o700)
    expect(readFileSync(join(target, 'marker'), 'utf8')).toBe('CLONED\n')
  })

  it('falls back to symlink when macOS clone-copy is unavailable', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    const cloneWorktreePath = vi.fn(async () => {
      throw new Error('clonefile unsupported')
    })

    await createWorktreeLinkedPaths(primary, worktree, ['.env'], {
      platform: 'darwin',
      cloneWorktreePath
    })

    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(worktree, '.env'))).toBe(join(primary, '.env'))
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[worktree-symlinks] APFS clone-copy unavailable'),
      expect.any(Error)
    )
  })

  it('does not delete a target that appears while APFS clone-copy is failing', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    const cloneWorktreePath = vi.fn(async (_source: string, target: string) => {
      writeFileSync(target, 'RACE=1\n')
      throw new Error('clonefile failed after target appeared')
    })

    await createWorktreeLinkedPaths(primary, worktree, ['.env'], {
      platform: 'darwin',
      cloneWorktreePath
    })

    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('RACE=1\n')
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('[worktree-symlinks] Failed to link ".env"'),
      expect.any(Error)
    )
  })

  it('keeps symlink sources as symlinks instead of APFS clone-copying their targets', async () => {
    writeFileSync(join(primary, '.env.real'), 'SECRET=1\n')
    symlinkSync(join(primary, '.env.real'), join(primary, '.env'), 'file')
    const cloneWorktreePath = vi.fn(async () => {
      throw new Error('clone should not be called for symlink sources')
    })

    await createWorktreeLinkedPaths(primary, worktree, ['.env'], {
      platform: 'darwin',
      cloneWorktreePath
    })

    expect(cloneWorktreePath).not.toHaveBeenCalled()
    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(worktree, '.env'))).toBe(join(primary, '.env'))
  })

  it('reflink clone-copies configured paths on Linux when the filesystem shares blocks', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    const deps = createReflinkCloneDeps({ supported: true })

    await createWorktreeLinkedPaths(primary, worktree, ['.env'], {
      platform: 'linux',
      reflinkCloneDeps: deps
    })

    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('SECRET=1\n')
    // A private copy: worktree edits stay in the worktree.
    writeFileSync(join(worktree, '.env'), 'SECRET=2\n')
    expect(readFileSync(join(primary, '.env'), 'utf8')).toBe('SECRET=1\n')
    // Neither the probe nor the clone leaves its temp file behind.
    expect(existsSync(join(worktree, '.orca-reflink-probe-test'))).toBe(false)
    expect(existsSync(join(worktree, '.orca-reflink-clone-test'))).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  posixIt('reflink clone-copies a directory on Linux and preserves its mode', async () => {
    const source = join(primary, 'node_modules')
    mkdirSync(source)
    writeFileSync(join(source, 'marker'), 'installed\n')
    chmodSync(source, 0o700)
    const deps = createReflinkCloneDeps({ supported: true })

    await createWorktreeLinkedPaths(primary, worktree, ['node_modules'], {
      platform: 'linux',
      reflinkCloneDeps: deps
    })

    const target = join(worktree, 'node_modules')
    expect(lstatSync(target).isSymbolicLink()).toBe(false)
    expect(statSync(target).mode & 0o777).toBe(0o700)
    expect(readFileSync(join(target, 'marker'), 'utf8')).toBe('installed\n')
    expect(vi.mocked(deps.reflinkTree)).toHaveBeenCalledWith(
      source,
      expect.stringContaining('.orca-reflink-stage-')
    )
  })

  it('falls back to a symlink on Linux when the filesystem cannot reflink', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    const deps = createReflinkCloneDeps({ supported: false })

    await createWorktreeLinkedPaths(primary, worktree, ['.env'], {
      platform: 'linux',
      reflinkCloneDeps: deps
    })

    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(worktree, '.env'))).toBe(join(primary, '.env'))
    expect(vi.mocked(deps.reflinkFile)).not.toHaveBeenCalled()
    // "Unavailable" is a verdict, not a failure — nothing to warn about.
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('falls back to a symlink when a Linux reflink fails after the probe passed', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    const deps = createReflinkCloneDeps({ supported: true })
    vi.mocked(deps.reflinkFile).mockRejectedValue(
      Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
    )

    await createWorktreeLinkedPaths(primary, worktree, ['.env'], {
      platform: 'linux',
      reflinkCloneDeps: deps
    })

    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[worktree-symlinks] reflink clone-copy unavailable'),
      expect.any(Error)
    )
  })

  it('byte-copies complete content after a strict Linux tree clone leaves an empty file', async () => {
    mkdirSync(join(primary, 'cache'))
    writeFileSync(join(primary, 'cache', 'file'), 'complete payload')
    const deps = createReflinkCloneDeps({ supported: true })
    vi.mocked(deps.reflinkTree).mockImplementation(async (_source, target) => {
      writeFileSync(join(target, 'file'), '')
      throw Object.assign(new Error('dirty block'), { code: 'EAGAIN' })
    })

    const skipped = await createWorktreeCopiedPaths(primary, worktree, ['cache'], {
      platform: 'linux',
      reflinkCloneDeps: deps
    })

    expect(skipped).toEqual([])
    expect(readFileSync(join(worktree, 'cache', 'file'), 'utf8')).toBe('complete payload')
    expect(readFileSync(join(primary, 'cache', 'file'), 'utf8')).toBe('complete payload')
  })

  // Perf: reflink support is a property of the filesystem pair, so the probe
  // must not scale with the number of materialized paths.
  it('probes reflink support once per filesystem pair on Linux', async () => {
    for (const name of ['.env', '.env.local', 'config.json', 'secrets.json']) {
      writeFileSync(join(primary, name), `${name}\n`)
    }
    const deps = createReflinkCloneDeps({ supported: true })

    await createWorktreeLinkedPaths(
      primary,
      worktree,
      ['.env', '.env.local', 'config.json', 'secrets.json'],
      { platform: 'linux', reflinkCloneDeps: deps }
    )

    expect(vi.mocked(deps.reflinkFileOrFail)).toHaveBeenCalledTimes(1)
    // The clones themselves still happen per path.
    expect(vi.mocked(deps.reflinkFile)).toHaveBeenCalledTimes(4)
  })

  it('does not overwrite a file target that appears before the reflink clone is published', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    const target = join(worktree, '.env')
    const deps = createReflinkCloneDeps({
      supported: true,
      onReflink: () => {
        writeFileSync(target, 'RACE=1\n')
      }
    })

    await createWorktreeLinkedPaths(primary, worktree, ['.env'], {
      platform: 'linux',
      reflinkCloneDeps: deps
    })

    expect(readFileSync(target, 'utf8')).toBe('RACE=1\n')
    expect(existsSync(join(worktree, '.orca-reflink-clone-file-race'))).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  posixIt(
    'keeps symlink sources as symlinks instead of reflinking their targets on Linux',
    async () => {
      writeFileSync(join(primary, '.env.real'), 'SECRET=1\n')
      symlinkSync(join(primary, '.env.real'), join(primary, '.env'), 'file')
      const deps = createReflinkCloneDeps({ supported: true })

      await createWorktreeLinkedPaths(primary, worktree, ['.env'], {
        platform: 'linux',
        reflinkCloneDeps: deps
      })

      expect(vi.mocked(deps.reflinkFileOrFail)).not.toHaveBeenCalled()
      expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(worktree, '.env'))).toBe(join(primary, '.env'))
    }
  )
})

// Why: a plain `fs.symlink` needs Developer Mode or admin on Windows, so an
// ordinary Windows user gets EPERM and silently ends up with no shared
// directory at all. A junction needs no privilege — but it cannot target a UNC
// path, which is exactly where a WSL project's repo lives, so the symlink has
// to stay as a fallback rather than be replaced.
describe('worktreeSymlinkTypeCandidates', () => {
  it('tries a junction before a symlink for a directory on Windows', () => {
    expect(worktreeSymlinkTypeCandidates('win32', true)).toEqual(['junction', 'dir'])
  })

  it('keeps the symlink fallback so a UNC (WSL) target still works', () => {
    expect(worktreeSymlinkTypeCandidates('win32', true).at(-1)).toBe('dir')
  })

  it('never uses a junction for a file, which junctions cannot represent', () => {
    expect(worktreeSymlinkTypeCandidates('win32', false)).toEqual(['file'])
  })

  it('makes exactly one attempt off Windows, where the type is ignored', () => {
    expect(worktreeSymlinkTypeCandidates('darwin', true)).toEqual(['dir'])
    expect(worktreeSymlinkTypeCandidates('linux', true)).toEqual(['dir'])
    expect(worktreeSymlinkTypeCandidates('linux', false)).toEqual(['file'])
  })
})

describe('createWorktreeSharedPaths', () => {
  let root: string
  let primary: string
  let worktree: string
  let warn: ReturnType<typeof vi.spyOn>
  let error: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-sharedpaths-'))
    primary = join(root, 'primary')
    worktree = join(root, 'worktree')
    mkdirSync(primary, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    error.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  // Why: an APFS clone would give the worktree its own node_modules, defeating
  // one-install-serves-all. Share mode must symlink even where cloning works.
  posixIt('symlinks on macOS instead of APFS clone-copying', async () => {
    mkdirSync(join(primary, 'node_modules'))
    writeFileSync(join(primary, 'node_modules', 'marker'), 'ORIG\n')
    const cloneWorktreePath = vi.fn()

    await createWorktreeSharedPaths(primary, worktree, ['node_modules'], {
      platform: 'darwin',
      cloneWorktreePath
    })

    expect(cloneWorktreePath).not.toHaveBeenCalled()
    expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(true)
  })

  posixIt('symlinks on Linux instead of reflink clone-copying', async () => {
    mkdirSync(join(primary, 'node_modules'))
    writeFileSync(join(primary, 'node_modules', 'marker'), 'ORIG\n')
    const deps = createReflinkCloneDeps({ supported: true })

    await createWorktreeSharedPaths(primary, worktree, ['node_modules'], {
      platform: 'linux',
      reflinkCloneDeps: deps
    })

    expect(vi.mocked(deps.reflinkFileOrFail)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.reflinkTree)).not.toHaveBeenCalled()
    expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(true)
  })

  posixIt('shares one directory so worktree writes reach the primary checkout', async () => {
    mkdirSync(join(primary, 'node_modules'))

    await createWorktreeSharedPaths(primary, worktree, ['node_modules'], { platform: 'linux' })

    writeFileSync(join(worktree, 'node_modules', 'installed'), 'SHARED\n')
    expect(readFileSync(join(primary, 'node_modules', 'installed'), 'utf8')).toBe('SHARED\n')
  })

  posixIt('skips a path already materialized by the per-user symlink pass', async () => {
    mkdirSync(join(primary, 'node_modules'))
    mkdirSync(join(worktree, 'node_modules'))

    await createWorktreeSharedPaths(primary, worktree, ['node_modules'], { platform: 'linux' })

    expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(false)
  })

  it('rejects unsafe paths without touching the filesystem', async () => {
    writeFileSync(join(root, 'outside.txt'), 'DO_NOT_TOUCH')

    await createWorktreeSharedPaths(primary, worktree, ['../outside.txt', '/etc/passwd'], {
      platform: 'linux'
    })

    expect(readFileSync(join(root, 'outside.txt'), 'utf8')).toBe('DO_NOT_TOUCH')
    expect(warn).toHaveBeenCalled()
  })
})

describe('createWorktreeCopiedPaths', () => {
  let root: string
  let primary: string
  let worktree: string
  let warn: ReturnType<typeof vi.spyOn>
  let error: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-copiedpaths-'))
    primary = join(root, 'primary')
    worktree = join(root, 'worktree')
    mkdirSync(primary, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    error.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  it('copies a file so worktree edits never leak back to the primary checkout', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')

    await createWorktreeCopiedPaths(primary, worktree, ['.env'], { platform: 'linux' })

    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('SECRET=1\n')
    writeFileSync(join(worktree, '.env'), 'SECRET=2\n')
    expect(readFileSync(join(primary, '.env'), 'utf8')).toBe('SECRET=1\n')
  })

  it('copies a directory recursively without symlinking', async () => {
    mkdirSync(join(primary, '.vscode'))
    writeFileSync(join(primary, '.vscode', 'settings.json'), '{}')

    await createWorktreeCopiedPaths(primary, worktree, ['.vscode'], { platform: 'linux' })

    expect(lstatSync(join(worktree, '.vscode')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(worktree, '.vscode', 'settings.json'), 'utf8')).toBe('{}')
  })

  it('creates parent directories lazily for nested paths', async () => {
    mkdirSync(join(primary, 'apps', 'web'), { recursive: true })
    writeFileSync(join(primary, 'apps', 'web', '.env'), 'A=1')

    await createWorktreeCopiedPaths(primary, worktree, ['apps/web/.env'], { platform: 'linux' })

    expect(readFileSync(join(worktree, 'apps', 'web', '.env'), 'utf8')).toBe('A=1')
  })

  // Finding 1 regression: a symlinked include entry must become an independent
  // copy, not a symlink, or worktree edits would leak back into the shared target.
  posixIt('dereferences a symlinked file entry so edits do not leak to the primary', async () => {
    writeFileSync(join(primary, '.env.shared'), 'SECRET=1\n')
    symlinkSync(join(primary, '.env.shared'), join(primary, '.env'))

    await createWorktreeCopiedPaths(primary, worktree, ['.env'], { platform: 'linux' })

    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(false)
    writeFileSync(join(worktree, '.env'), 'SECRET=2\n')
    expect(readFileSync(join(primary, '.env.shared'), 'utf8')).toBe('SECRET=1\n')
  })

  posixIt('dereferences a symlinked directory entry into an independent copy', async () => {
    mkdirSync(join(primary, '.cache-real'))
    writeFileSync(join(primary, '.cache-real', 'f'), 'ORIG\n')
    symlinkSync(join(primary, '.cache-real'), join(primary, '.cache'), 'dir')

    await createWorktreeCopiedPaths(primary, worktree, ['.cache'], { platform: 'linux' })

    expect(lstatSync(join(worktree, '.cache')).isSymbolicLink()).toBe(false)
    writeFileSync(join(worktree, '.cache', 'f'), 'CHANGED\n')
    expect(readFileSync(join(primary, '.cache-real', 'f'), 'utf8')).toBe('ORIG\n')
  })

  it('preserves a pre-existing target in the worktree (no clobber)', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    writeFileSync(join(worktree, '.env'), 'MINE=1\n')

    await createWorktreeCopiedPaths(primary, worktree, ['.env'], { platform: 'linux' })

    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('MINE=1\n')
  })

  it('rejects traversal and treats absolute paths as repo-relative', async () => {
    writeFileSync(join(root, 'outside.txt'), 'OUT=1')

    await createWorktreeCopiedPaths(primary, worktree, ['../outside.txt', '/etc/passwd'], {
      platform: 'linux'
    })

    expect(existsSync(join(worktree, 'outside.txt'))).toBe(false)
    // `/etc/passwd` → `etc/passwd`, absent from primary → silently skipped.
    expect(existsSync(join(worktree, 'etc'))).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('falls back to a real copy, not a symlink, when macOS clone-copy is unavailable', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    const cloneWorktreePath = vi.fn(async () => {
      throw new Error('clonefile unsupported')
    })

    await createWorktreeCopiedPaths(primary, worktree, ['.env'], {
      platform: 'darwin',
      cloneWorktreePath
    })

    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('SECRET=1\n')
  })

  it('reflink clone-copies .worktreeinclude paths on Linux so edits stay private', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    const deps = createReflinkCloneDeps({ supported: true })

    await createWorktreeCopiedPaths(primary, worktree, ['.env'], {
      platform: 'linux',
      reflinkCloneDeps: deps
    })

    expect(vi.mocked(deps.reflinkFile)).toHaveBeenCalledTimes(1)
    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(false)
    writeFileSync(join(worktree, '.env'), 'SECRET=2\n')
    expect(readFileSync(join(primary, '.env'), 'utf8')).toBe('SECRET=1\n')
  })

  it('falls back to a real copy, not a symlink, when the Linux filesystem cannot reflink', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    const deps = createReflinkCloneDeps({ supported: false })

    await createWorktreeCopiedPaths(primary, worktree, ['.env'], {
      platform: 'linux',
      reflinkCloneDeps: deps
    })

    expect(vi.mocked(deps.reflinkFile)).not.toHaveBeenCalled()
    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('SECRET=1\n')
  })

  it('uses APFS clone-copy for configured paths on macOS', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    const cloneWorktreePath = vi.fn(async (_source: string, target: string) => {
      writeFileSync(target, 'CLONED=1\n')
    })

    await createWorktreeCopiedPaths(primary, worktree, ['.env'], {
      platform: 'darwin',
      cloneWorktreePath
    })

    expect(cloneWorktreePath).toHaveBeenCalledWith(
      join(primary, '.env'),
      join(worktree, '.env'),
      false
    )
    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('CLONED=1\n')
  })

  // Perf: the native filesystem probe must not scale with the number of copied
  // paths — one probe per distinct volume, cached across the materialization.
  it('probes each APFS volume once regardless of how many paths are copied', async () => {
    for (const name of ['.env', '.env.local', 'config.json', 'secrets.json']) {
      writeFileSync(join(primary, name), `${name}\n`)
    }
    const deps = createApfsCloneDeps({ onClone: () => {} })

    await createWorktreeCopiedPaths(
      primary,
      worktree,
      ['.env', '.env.local', 'config.json', 'secrets.json'],
      { platform: 'darwin', apfsCloneDeps: deps }
    )

    const execFileAsyncMock = vi.mocked(deps.execFileAsync)
    expect(execFileAsyncMock.mock.calls.filter(([, args]) => args[0] === 'probe')).toHaveLength(1)
    expect(execFileAsyncMock.mock.calls.filter(([, args]) => args[0] === 'clone')).toHaveLength(4)
  })
})

describe('removeWorktreeSymlinks', () => {
  let root: string
  let primary: string
  let worktree: string
  let error: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-unlink-'))
    primary = join(root, 'primary')
    worktree = join(root, 'worktree')
    mkdirSync(primary, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    error.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  it('unlinks configured symlinks from the worktree', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    mkdirSync(join(primary, 'node_modules'))
    symlinkSync(join(primary, '.env'), join(worktree, '.env'), 'file')
    symlinkSync(join(primary, 'node_modules'), join(worktree, 'node_modules'), 'dir')

    await removeWorktreeSymlinks(worktree, ['.env', 'node_modules'])

    expect(existsSync(join(worktree, '.env'))).toBe(false)
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false)
    // Source is untouched.
    expect(statSync(join(primary, '.env')).isFile()).toBe(true)
    expect(statSync(join(primary, 'node_modules')).isDirectory()).toBe(true)
  })

  it('leaves a regular file at the configured path alone', async () => {
    // Why: a user who created a real file at `.env` (instead of symlinking)
    // must not lose it just because `.env` is in the configured list.
    writeFileSync(join(worktree, '.env'), 'USER_WROTE_THIS=1\n')

    await removeWorktreeSymlinks(worktree, ['.env'])

    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(false)
    expect(statSync(join(worktree, '.env')).isFile()).toBe(true)
  })

  it('identifies only actual symlinks for removal preflight', async () => {
    writeFileSync(join(primary, '.env'), 'PRIMARY=1\n')
    symlinkSync(join(primary, '.env'), join(worktree, '.env'))
    writeFileSync(join(worktree, 'config.json'), '{}\n')

    await expect(
      findExistingWorktreeSymlinkPaths(worktree, ['.env', 'config.json', 'missing'])
    ).resolves.toEqual(['.env'])
  })

  it('leaves clone-copied regular files for git removal to judge', async () => {
    writeFileSync(join(worktree, '.env'), 'CLONED=1\n')

    await removeWorktreeLinkedPaths(worktree, ['.env'])

    expect(existsSync(join(worktree, '.env'))).toBe(true)
  })

  it('ignores missing entries', async () => {
    await removeWorktreeSymlinks(worktree, ['.env', 'node_modules'])
    expect(error).not.toHaveBeenCalled()
  })

  it('rejects unsafe paths without touching the filesystem', async () => {
    // Parent-dir traversal is silently skipped; no unlink attempted.
    writeFileSync(join(root, 'outside-file'), 'DO_NOT_DELETE')
    await removeWorktreeSymlinks(worktree, ['../outside-file'])
    expect(existsSync(join(root, 'outside-file'))).toBe(true)
  })

  it('is a no-op for an empty paths list', async () => {
    await removeWorktreeSymlinks(worktree, [])
    expect(error).not.toHaveBeenCalled()
  })
})
