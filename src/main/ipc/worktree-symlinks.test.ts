import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  statSync,
  lstatSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWorktreeCopiedPaths,
  createWorktreeLinkedPaths,
  createWorktreeSharedPaths,
  removeWorktreeSymlinks
} from './worktree-symlinks'

type WorktreeLinkedPathOptionsForTest = NonNullable<Parameters<typeof createWorktreeLinkedPaths>[3]>
type ApfsCloneDepsForTest = NonNullable<WorktreeLinkedPathOptionsForTest['apfsCloneDeps']>
const posixIt = process.platform === 'win32' ? it.skip : it

function createApfsCloneDeps(options: {
  uuid?: string
  onCp?: (args: readonly string[]) => void
  onDiskutil?: () => void
  diskutilError?: Error
}): ApfsCloneDepsForTest {
  const execFileAsync = vi.fn<ApfsCloneDepsForTest['execFileAsync']>(async (file, args) => {
    if (file === '/bin/df') {
      return {
        stdout: `Filesystem 512-blocks Used Available Capacity Mounted on
/dev/disk3s1 100 50 50 50% /
`,
        stderr: ''
      }
    }
    if (file === '/usr/sbin/diskutil') {
      if (options.diskutilError) {
        throw options.diskutilError
      }
      options.onDiskutil?.()
      return {
        stdout: `<plist><dict><key>FilesystemName</key><string>APFS</string></dict></plist>`,
        stderr: ''
      }
    }
    if (file === '/bin/cp') {
      options.onCp?.(args)
      return { stdout: '', stderr: '' }
    }
    throw new Error(`Unexpected execFile command: ${file}`)
  })
  return {
    execFileAsync,
    randomUUID: () => options.uuid ?? 'test'
  }
}

describe('createWorktreeSymlinks', () => {
  let root: string
  let primary: string
  let worktree: string
  let warn: ReturnType<typeof vi.spyOn>
  let error: ReturnType<typeof vi.spyOn>

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

  it('does not overwrite a file target that appears before APFS clone-copy is published', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    const target = join(worktree, '.env')
    const deps = createApfsCloneDeps({
      uuid: 'file-race',
      onCp: (args) => {
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
      onDiskutil: () => {
        if (!createdRacedTarget) {
          createdRacedTarget = true
          mkdirSync(target)
          writeFileSync(join(target, 'user-marker'), 'USER\n')
        }
      },
      onCp: () => {
        throw new Error('APFS clone-copy should not run after the target appears')
      }
    })

    await createWorktreeLinkedPaths(primary, worktree, ['node_modules'], {
      platform: 'darwin',
      apfsCloneDeps: deps
    })

    expect(readFileSync(join(target, 'user-marker'), 'utf8')).toBe('USER\n')
    expect(existsSync(join(target, 'primary-marker'))).toBe(false)
    expect(deps.execFileAsync).not.toHaveBeenCalledWith('/bin/cp', expect.anything())
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
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

  // Shared mode must link even on APFS so one dependency install serves every worktree.

  posixIt('shares one directory so worktree writes reach the primary checkout', async () => {
    mkdirSync(join(primary, 'node_modules'))

    await createWorktreeSharedPaths(primary, worktree, ['node_modules'], { platform: 'linux' })

    writeFileSync(join(worktree, 'node_modules', 'installed'), 'SHARED\n')
    expect(readFileSync(join(primary, 'node_modules', 'installed'), 'utf8')).toBe('SHARED\n')
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

  posixIt('dereferences a symlinked file entry so edits do not leak to the primary', async () => {
    writeFileSync(join(primary, '.env.shared'), 'SECRET=1\n')
    symlinkSync(join(primary, '.env.shared'), join(primary, '.env'))

    await createWorktreeCopiedPaths(primary, worktree, ['.env'], { platform: 'linux' })

    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(false)
    writeFileSync(join(worktree, '.env'), 'SECRET=2\n')
    expect(readFileSync(join(primary, '.env.shared'), 'utf8')).toBe('SECRET=1\n')
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
    expect(statSync(join(primary, '.env')).isFile()).toBe(true)
    expect(statSync(join(primary, 'node_modules')).isDirectory()).toBe(true)
  })

  it('leaves a regular file at the configured path alone', async () => {
    writeFileSync(join(worktree, '.env'), 'USER_WROTE_THIS=1\n')

    await removeWorktreeSymlinks(worktree, ['.env'])

    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(false)
    expect(statSync(join(worktree, '.env')).isFile()).toBe(true)
  })

  it('rejects unsafe paths without touching the filesystem', async () => {
    writeFileSync(join(root, 'outside-file'), 'DO_NOT_DELETE')
    await removeWorktreeSymlinks(worktree, ['../outside-file'])
    expect(existsSync(join(root, 'outside-file'))).toBe(true)
  })
})
