import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findExistingWorktreeSymlinkPaths, getSafeRelativePath } from './worktree-symlink-detection'

describe('getSafeRelativePath', () => {
  // The only case in this file that binds the production change: every one of
  // these is admitted by at least one host's `path.isAbsolute` — the
  // drive-relative spellings are admitted by *every* host's, Windows included.
  it('rejects Windows drive-qualified entries, including drive-relative, on any host', () => {
    expect(getSafeRelativePath('C:\\Windows\\Temp')).toEqual({ safe: false })
    expect(getSafeRelativePath('C:/Windows/Temp')).toEqual({ safe: false })
    expect(getSafeRelativePath('  d:\\payload  ')).toEqual({ safe: false })
    // Drive-RELATIVE: `win32.resolve('D:\\wt', 'C:payload')` discards the
    // worktree root and lands under C:'s current directory.
    expect(getSafeRelativePath('C:payload')).toEqual({ safe: false })
    expect(getSafeRelativePath('c:')).toEqual({ safe: false })
  })

  it('keeps colon-bearing paths that are not drive-qualified', () => {
    expect(getSafeRelativePath('build:out')).toEqual({ safe: true, rel: 'build:out' })
    expect(getSafeRelativePath('logs/2026-08-31T10:00.txt')).toEqual({
      safe: true,
      rel: 'logs/2026-08-31T10:00.txt'
    })
  })

  // These pin the rest of the guard expression, which this commit rewrote:
  // both `isAbsolute` calls were deleted as provably subsumed by the strip
  // above plus the drive check, so their inputs must still be judged the same.
  it('still strips leading separators of either flavour and keeps the remainder relative', () => {
    expect(getSafeRelativePath('node_modules')).toEqual({ safe: true, rel: 'node_modules' })
    expect(getSafeRelativePath('  .env  ')).toEqual({ safe: true, rel: '.env' })
    expect(getSafeRelativePath('/.env')).toEqual({ safe: true, rel: '.env' })
    expect(getSafeRelativePath('\\.env')).toEqual({ safe: true, rel: '.env' })
    expect(getSafeRelativePath('//srv/share/x')).toEqual({ safe: true, rel: 'srv/share/x' })
  })

  it('still rejects empty, whitespace-only, and parent-directory entries', () => {
    expect(getSafeRelativePath('')).toEqual({ safe: false })
    expect(getSafeRelativePath('   ')).toEqual({ safe: false })
    expect(getSafeRelativePath('../secrets')).toEqual({ safe: false })
    expect(getSafeRelativePath('safe/../../escape')).toEqual({ safe: false })
    expect(getSafeRelativePath('..\\escape')).toEqual({ safe: false })
    expect(getSafeRelativePath('foo\\..\\..\\escape')).toEqual({ safe: false })
  })
})

describe('findExistingWorktreeSymlinkPaths', () => {
  let root: string
  let primary: string
  let worktree: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-symlink-detection-'))
    primary = join(root, 'primary')
    worktree = join(root, 'worktree')
    mkdirSync(primary)
    mkdirSync(worktree)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  // Why skipped on Windows rather than made platform-independent: the fixture
  // needs a real on-disk directory named `C:`, which only POSIX allows. The
  // Windows half of this guard is bound by the unit tests above, which run
  // everywhere because they never touch the filesystem.
  const posixIt = process.platform === 'win32' ? it.skip : it

  posixIt('does not report a drive-qualified entry even when the literal path exists', async () => {
    mkdirSync(join(worktree, 'C:'))
    writeFileSync(join(primary, 'payload'), 'X=1\n')
    symlinkSync(join(primary, 'payload'), join(worktree, 'C:', 'payload'))
    symlinkSync(join(primary, 'payload'), join(worktree, 'C:payload'))

    await expect(
      findExistingWorktreeSymlinkPaths(worktree, ['C:/payload', 'C:\\payload', 'C:payload'])
    ).resolves.toEqual([])
  })
})
