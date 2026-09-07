import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WorktreeCloneUnavailableError,
  WorktreeLinkedPathTargetExistsError
} from './worktree-clone-copy-errors'
import {
  canCloneWithReflink,
  cloneWorktreePathWithReflink,
  defaultReflinkCloneDeps,
  type ReflinkCloneDeps,
  type ReflinkFilesystemCache
} from './worktree-reflink-clone'

const posixIt = process.platform === 'win32' ? it.skip : it
const linuxIt = process.platform === 'linux' ? it : it.skip

function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code })
}

/** A reflink backend that copies bytes where the real one would share them.
 *  `probeError` is what the forced reflink throws — the way a filesystem
 *  without the feature answers. */
function createDeps(
  options: {
    probeError?: string
    cloneError?: string
    treeError?: string
    onTree?: (source: string, target: string) => void
    uuid?: string
  } = {}
): ReflinkCloneDeps {
  return {
    reflinkFileOrFail: vi.fn(async (source: string, target: string) => {
      if (options.probeError) {
        throw errnoError(options.probeError)
      }
      copyFileSync(source, target)
    }),
    reflinkFile: vi.fn(async (source: string, target: string) => {
      if (options.cloneError) {
        throw errnoError(options.cloneError)
      }
      copyFileSync(source, target)
    }),
    reflinkTree: vi.fn(async (source: string, target: string) => {
      options.onTree?.(source, target)
      if (options.treeError) {
        throw errnoError(options.treeError)
      }
      cpSync(source, target, { recursive: true, force: false, errorOnExist: false })
    }),
    randomUUID: () => options.uuid ?? 'test'
  }
}

function probeLeftovers(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.startsWith('.orca-reflink-'))
}

describe('canCloneWithReflink', () => {
  let root: string
  let primary: string
  let worktree: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-reflink-probe-'))
    primary = join(root, 'primary')
    worktree = join(root, 'worktree')
    mkdirSync(primary, { recursive: true })
    mkdirSync(worktree, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('answers yes when a forced reflink of a real file succeeds, and removes the probe file', async () => {
    const source = join(primary, '.env')
    writeFileSync(source, 'SECRET=1\n')
    const deps = createDeps()

    await expect(canCloneWithReflink(source, worktree, deps)).resolves.toBe(true)

    expect(vi.mocked(deps.reflinkFileOrFail)).toHaveBeenCalledWith(
      source,
      join(worktree, '.orca-reflink-probe-test')
    )
    expect(probeLeftovers(worktree)).toEqual([])
  })

  it('answers no when the filesystem declines the forced reflink', async () => {
    const source = join(primary, '.env')
    writeFileSync(source, 'SECRET=1\n')

    await expect(
      canCloneWithReflink(source, worktree, createDeps({ probeError: 'ENOTSUP' }))
    ).resolves.toBe(false)
    expect(probeLeftovers(worktree)).toEqual([])
  })

  // Why: EAGAIN is OpenZFS refusing a block still in the open transaction
  // group. The filesystem understood the request, so the pair can reflink;
  // the unforced clone copies that one file's bytes and shares the rest.
  it('treats EAGAIN as support', async () => {
    const source = join(primary, '.env')
    writeFileSync(source, 'SECRET=1\n')

    await expect(
      canCloneWithReflink(source, worktree, createDeps({ probeError: 'EAGAIN' }))
    ).resolves.toBe(true)
  })

  it('probes with a non-empty file found inside a directory source', async () => {
    const source = join(primary, 'node_modules')
    mkdirSync(join(source, 'pkg'), { recursive: true })
    writeFileSync(join(source, 'empty-marker'), '')
    writeFileSync(join(source, 'pkg', 'index.js'), 'module.exports = 1\n')
    const deps = createDeps()

    await expect(canCloneWithReflink(source, worktree, deps)).resolves.toBe(true)

    expect(vi.mocked(deps.reflinkFileOrFail)).toHaveBeenCalledWith(
      join(source, 'pkg', 'index.js'),
      expect.any(String)
    )
  })

  it('answers no without probing when the source holds only empty files, leaving the pair unprobed', async () => {
    const emptyOnly = join(primary, '.cache')
    mkdirSync(emptyOnly)
    writeFileSync(join(emptyOnly, 'marker'), '')
    const fuller = join(primary, '.env')
    writeFileSync(fuller, 'SECRET=1\n')
    const deps = createDeps()
    const cache: ReflinkFilesystemCache = new Map()

    await expect(canCloneWithReflink(emptyOnly, worktree, deps, cache)).resolves.toBe(false)
    expect(vi.mocked(deps.reflinkFileOrFail)).not.toHaveBeenCalled()

    // A later source with bytes in it still gets to answer for the pair.
    await expect(canCloneWithReflink(fuller, worktree, deps, cache)).resolves.toBe(true)
    expect(vi.mocked(deps.reflinkFileOrFail)).toHaveBeenCalledTimes(1)
  })

  it('caches the verdict per filesystem pair', async () => {
    for (const name of ['.env', 'config.json']) {
      writeFileSync(join(primary, name), `${name}\n`)
    }
    const deps = createDeps()
    const cache: ReflinkFilesystemCache = new Map()

    await expect(canCloneWithReflink(join(primary, '.env'), worktree, deps, cache)).resolves.toBe(
      true
    )
    await expect(
      canCloneWithReflink(join(primary, 'config.json'), worktree, deps, cache)
    ).resolves.toBe(true)

    expect(vi.mocked(deps.reflinkFileOrFail)).toHaveBeenCalledTimes(1)
  })

  it('answers no for a missing source', async () => {
    await expect(
      canCloneWithReflink(join(primary, 'missing'), worktree, createDeps())
    ).resolves.toBe(false)
  })
})

describe('cloneWorktreePathWithReflink', () => {
  let root: string
  let primary: string
  let worktree: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-reflink-clone-'))
    primary = join(root, 'primary')
    worktree = join(root, 'worktree')
    mkdirSync(primary, { recursive: true })
    mkdirSync(worktree, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses without writing when the probe fails', async () => {
    const source = join(primary, '.env')
    writeFileSync(source, 'SECRET=1\n')
    const target = join(worktree, '.env')
    const deps = createDeps({ probeError: 'ENOTSUP' })

    await expect(cloneWorktreePathWithReflink(source, target, false, deps)).rejects.toBeInstanceOf(
      WorktreeCloneUnavailableError
    )

    expect(existsSync(target)).toBe(false)
    expect(vi.mocked(deps.reflinkFile)).not.toHaveBeenCalled()
    expect(probeLeftovers(worktree)).toEqual([])
  })

  it('clones a file through a temp path and publishes it with link(2)', async () => {
    const source = join(primary, '.env')
    writeFileSync(source, 'SECRET=1\n')
    const target = join(worktree, '.env')
    const deps = createDeps()

    await cloneWorktreePathWithReflink(source, target, false, deps)

    expect(vi.mocked(deps.reflinkFile)).toHaveBeenCalledWith(
      source,
      join(worktree, '.orca-reflink-clone-test')
    )
    expect(readFileSync(target, 'utf8')).toBe('SECRET=1\n')
    expect(lstatSync(target).isSymbolicLink()).toBe(false)
    // The temp name is gone, so the published file is the only link left.
    expect(statSync(target).nlink).toBe(1)
    expect(probeLeftovers(worktree)).toEqual([])
  })

  it('reports an existing file target instead of clobbering it', async () => {
    const source = join(primary, '.env')
    writeFileSync(source, 'SECRET=1\n')
    const target = join(worktree, '.env')
    writeFileSync(target, 'MINE=1\n')

    await expect(
      cloneWorktreePathWithReflink(source, target, false, createDeps())
    ).rejects.toBeInstanceOf(WorktreeLinkedPathTargetExistsError)

    expect(readFileSync(target, 'utf8')).toBe('MINE=1\n')
    expect(probeLeftovers(worktree)).toEqual([])
  })

  posixIt('reserves the directory, clones into it, and applies the source mode', async () => {
    const source = join(primary, 'node_modules')
    mkdirSync(join(source, 'pkg'), { recursive: true })
    writeFileSync(join(source, 'pkg', 'index.js'), 'module.exports = 1\n')
    chmodSync(source, 0o700)
    const target = join(worktree, 'node_modules')
    const deps = createDeps()

    await cloneWorktreePathWithReflink(source, target, true, deps)

    expect(vi.mocked(deps.reflinkTree)).toHaveBeenCalledWith(source, target)
    expect(statSync(target).mode & 0o777).toBe(0o700)
    expect(readFileSync(join(target, 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
  })

  it('reports an existing directory target instead of merging into it', async () => {
    const source = join(primary, 'node_modules')
    mkdirSync(source)
    writeFileSync(join(source, 'primary-marker'), 'PRIMARY\n')
    const target = join(worktree, 'node_modules')
    mkdirSync(target)
    writeFileSync(join(target, 'user-marker'), 'USER\n')
    const deps = createDeps()

    await expect(cloneWorktreePathWithReflink(source, target, true, deps)).rejects.toBeInstanceOf(
      WorktreeLinkedPathTargetExistsError
    )

    expect(vi.mocked(deps.reflinkTree)).not.toHaveBeenCalled()
    expect(readFileSync(join(target, 'user-marker'), 'utf8')).toBe('USER\n')
    expect(existsSync(join(target, 'primary-marker'))).toBe(false)
  })

  it('removes only the empty reservation when the tree clone fails before writing', async () => {
    const source = join(primary, 'node_modules')
    mkdirSync(source)
    writeFileSync(join(source, 'marker'), 'PRIMARY\n')
    const target = join(worktree, 'node_modules')

    await expect(
      cloneWorktreePathWithReflink(source, target, true, createDeps({ treeError: 'EIO' }))
    ).rejects.toMatchObject({ code: 'EIO' })

    expect(existsSync(target)).toBe(false)
  })

  it('keeps a partly cloned directory for review when the tree clone fails midway', async () => {
    const source = join(primary, 'node_modules')
    mkdirSync(source)
    writeFileSync(join(source, 'marker'), 'PRIMARY\n')
    const target = join(worktree, 'node_modules')
    const deps = createDeps({
      treeError: 'EIO',
      onTree: (_source, treeTarget) => {
        writeFileSync(join(treeTarget, 'marker'), 'PARTIAL\n')
      }
    })

    await expect(cloneWorktreePathWithReflink(source, target, true, deps)).rejects.toMatchObject({
      code: 'EIO'
    })

    expect(readFileSync(join(target, 'marker'), 'utf8')).toBe('PARTIAL\n')
  })

  it('creates missing parent directories for a nested target', async () => {
    mkdirSync(join(primary, 'apps', 'web'), { recursive: true })
    const source = join(primary, 'apps', 'web', '.env')
    writeFileSync(source, 'A=1\n')
    const target = join(worktree, 'apps', 'web', '.env')

    await cloneWorktreePathWithReflink(source, target, false, createDeps())

    expect(readFileSync(target, 'utf8')).toBe('A=1\n')
    expect(probeLeftovers(join(worktree, 'apps', 'web'))).toEqual([])
  })

  // Why: the default tree clone is a real coreutils spawn; on tmpfs
  // `--reflink=auto` degrades to a byte copy, so this exercises the process
  // plumbing, no-clobber and symlink handling on any Linux host.
  linuxIt('clones a tree with coreutils cp, keeping raced files and nested symlinks', async () => {
    const source = join(primary, 'node_modules')
    mkdirSync(join(source, 'pkg'), { recursive: true })
    writeFileSync(join(source, 'pkg', 'index.js'), 'module.exports = 1\n')
    writeFileSync(join(source, 'marker'), 'PRIMARY\n')
    symlinkSync(join('pkg', 'index.js'), join(source, 'entry.js'))
    const target = join(worktree, 'node_modules')
    mkdirSync(target)
    writeFileSync(join(target, 'marker'), 'RACED\n')

    await defaultReflinkCloneDeps.reflinkTree(source, target)

    expect(readFileSync(join(target, 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
    expect(readFileSync(join(target, 'marker'), 'utf8')).toBe('RACED\n')
    expect(lstatSync(join(target, 'entry.js')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(target, 'entry.js'))).toBe(join('pkg', 'index.js'))
  })

  linuxIt('surfaces a non-zero cp exit as an error', async () => {
    await expect(
      defaultReflinkCloneDeps.reflinkTree(join(primary, 'missing'), join(worktree, 'x'))
    ).rejects.toThrow(/cp --reflink exited 1/)
  })

  // Why: the only host-dependent test here, and deliberately so — whatever the
  // host's temp filesystem can do, the probe and the clone must agree on it.
  // On ext4 or tmpfs the clone refuses; on btrfs, XFS with reflink, or OpenZFS
  // with block cloning it shares blocks. Run it with TMPDIR on each to see both.
  linuxIt('agrees with the real filesystem about whether it can share blocks', async () => {
    const source = join(primary, 'blob')
    const bytes = 'x'.repeat(1024 * 1024)
    writeFileSync(source, bytes)
    const target = join(worktree, 'blob')
    const cache: ReflinkFilesystemCache = new Map()

    const supported = await canCloneWithReflink(source, worktree, defaultReflinkCloneDeps, cache)
    const clone = cloneWorktreePathWithReflink(
      source,
      target,
      false,
      defaultReflinkCloneDeps,
      cache
    )

    if (supported) {
      await clone
      expect(readFileSync(target, 'utf8')).toBe(bytes)
      expect(lstatSync(target).isSymbolicLink()).toBe(false)
    } else {
      await expect(clone).rejects.toBeInstanceOf(WorktreeCloneUnavailableError)
      expect(existsSync(target)).toBe(false)
    }
    expect(probeLeftovers(worktree)).toEqual([])
  })
})
