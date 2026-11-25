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
  createWorktreeSharedPaths,
  removeWorktreeSymlinks
} from './worktree-symlinks'

const posixIt = process.platform === 'win32' ? it.skip : it

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

  it('unlinks a configured directory link while preserving its target and regular files', async () => {
    mkdirSync(join(primary, 'node_modules'))
    symlinkSync(join(primary, 'node_modules'), join(worktree, 'node_modules'), 'junction')
    writeFileSync(join(worktree, 'notes.txt'), 'local notes\n')

    await removeWorktreeSymlinks(worktree, ['node_modules', 'notes.txt'])

    expect(existsSync(join(worktree, 'node_modules'))).toBe(false)
    expect(statSync(join(primary, 'node_modules')).isDirectory()).toBe(true)
    expect(readFileSync(join(worktree, 'notes.txt'), 'utf8')).toBe('local notes\n')
  })

  // File symlinks need elevation or Developer Mode on Windows.
  posixIt('unlinks a configured file symlink while preserving its target', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    symlinkSync(join(primary, '.env'), join(worktree, '.env'), 'file')

    await removeWorktreeSymlinks(worktree, ['.env'])

    expect(existsSync(join(worktree, '.env'))).toBe(false)
    expect(statSync(join(primary, '.env')).isFile()).toBe(true)
  })

  it('rejects unsafe paths without touching the filesystem', async () => {
    writeFileSync(join(root, 'outside-file'), 'DO_NOT_DELETE')
    await removeWorktreeSymlinks(worktree, ['../outside-file'])
    expect(existsSync(join(root, 'outside-file'))).toBe(true)
  })
})
