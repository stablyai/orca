import { execFileSync } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorktreeSharedPaths } from './worktree-symlinks'
import {
  ensureWorktreeSharedSymlinkExclude,
  resolveWorktreeGitCommonDir,
  sharedSymlinkExcludePattern
} from './worktree-symlink-git-exclude'

const posixIt = process.platform === 'win32' ? it.skip : it

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

function initRepoWithCommit(repoRoot: string): void {
  mkdirSync(repoRoot, { recursive: true })
  git(repoRoot, ['init', '--quiet'])
  git(repoRoot, ['config', 'user.email', 'test@orca.test'])
  git(repoRoot, ['config', 'user.name', 'Orca Test'])
  // Why: directory-only ignore is the common spelling that misses symlinks.
  writeFileSync(join(repoRoot, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(repoRoot, 'README.md'), 'seed\n')
  git(repoRoot, ['add', 'README.md', '.gitignore'])
  git(repoRoot, ['commit', '--quiet', '-m', 'seed'])
}

describe('sharedSymlinkExcludePattern', () => {
  it('anchors at the repo root without a trailing slash', () => {
    expect(sharedSymlinkExcludePattern('node_modules')).toBe('/node_modules')
    expect(sharedSymlinkExcludePattern('node_modules/')).toBe('/node_modules')
    expect(sharedSymlinkExcludePattern('/apps/web/node_modules')).toBe('/apps/web/node_modules')
  })

  it('normalizes backslashes and rejects traversal or injection', () => {
    expect(sharedSymlinkExcludePattern('apps\\web\\node_modules')).toBe('/apps/web/node_modules')
    expect(sharedSymlinkExcludePattern('../escape')).toBeNull()
    expect(sharedSymlinkExcludePattern('node_modules\n/etc/passwd')).toBeNull()
    expect(sharedSymlinkExcludePattern('')).toBeNull()
  })

  it('escapes gitignore metacharacters and spaces as literal names', () => {
    expect(sharedSymlinkExcludePattern('cache*')).toBe('/cache\\*')
    expect(sharedSymlinkExcludePattern('foo?bar')).toBe('/foo\\?bar')
    expect(sharedSymlinkExcludePattern('br[ack]ets')).toBe('/br\\[ack\\]ets')
    expect(sharedSymlinkExcludePattern('has space')).toBe('/has\\ space')
    expect(sharedSymlinkExcludePattern('trailing  ')).toBe('/trailing\\ \\ ')
  })
})

describe('ensureWorktreeSharedSymlinkExclude', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-symlink-exclude-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  posixIt('appends a bare symlink rule to info/exclude for linked worktrees', async () => {
    const primary = join(root, 'primary')
    initRepoWithCommit(primary)
    const worktree = join(root, 'worktree')
    git(primary, ['worktree', 'add', '--quiet', '-b', 'feature', worktree])

    mkdirSync(join(primary, 'node_modules'))
    writeFileSync(join(primary, 'node_modules', 'pkg.js'), 'x')
    symlinkSync(join(primary, 'node_modules'), join(worktree, 'node_modules'))

    // Baseline: directory-only ignore does not match the symlink.
    expect(() => git(worktree, ['check-ignore', '-q', 'node_modules'])).toThrow()

    await ensureWorktreeSharedSymlinkExclude(worktree, ['node_modules'])

    const commonDir = await resolveWorktreeGitCommonDir(worktree)
    expect(commonDir).toBeTruthy()
    const exclude = readFileSync(join(commonDir!, 'info', 'exclude'), 'utf8')
    expect(exclude).toContain('/node_modules\n')

    // check-ignore exits 0 when ignored.
    git(worktree, ['check-ignore', '-q', 'node_modules'])
  })

  posixIt('excludes a symlink whose basename has gitignore metacharacters', async () => {
    const primary = join(root, 'primary')
    initRepoWithCommit(primary)
    const worktree = join(root, 'worktree-meta')
    git(primary, ['worktree', 'add', '--quiet', '-b', 'feature-meta', worktree])

    const sharedName = 'cache*'
    mkdirSync(join(primary, sharedName))
    writeFileSync(join(primary, sharedName, 'pkg.js'), 'x')
    symlinkSync(join(primary, sharedName), join(worktree, sharedName))

    expect(() => git(worktree, ['check-ignore', '-q', sharedName])).toThrow()

    await ensureWorktreeSharedSymlinkExclude(worktree, [sharedName])

    const commonDir = await resolveWorktreeGitCommonDir(worktree)
    const exclude = readFileSync(join(commonDir!, 'info', 'exclude'), 'utf8')
    expect(exclude).toContain('/cache\\*\n')
    git(worktree, ['check-ignore', '-q', sharedName])
  })

  posixIt('is a no-op when the pattern is already listed', async () => {
    const primary = join(root, 'primary')
    initRepoWithCommit(primary)
    const worktree = join(root, 'worktree')
    git(primary, ['worktree', 'add', '--quiet', '-b', 'feature', worktree])
    symlinkSync(join(primary, '.gitignore'), join(worktree, 'node_modules'))

    const commonDir = (await resolveWorktreeGitCommonDir(worktree))!
    const excludePath = join(commonDir, 'info', 'exclude')
    writeFileSync(excludePath, '/node_modules\n')

    await ensureWorktreeSharedSymlinkExclude(worktree, ['node_modules'])
    expect(readFileSync(excludePath, 'utf8')).toBe('/node_modules\n')
  })

  posixIt('still appends bare rule when only a directory-only pattern exists', async () => {
    const primary = join(root, 'primary')
    initRepoWithCommit(primary)
    const worktree = join(root, 'worktree-dir-only')
    git(primary, ['worktree', 'add', '--quiet', '-b', 'feature-dir', worktree])
    symlinkSync(join(primary, '.gitignore'), join(worktree, 'node_modules'))

    const commonDir = (await resolveWorktreeGitCommonDir(worktree))!
    const excludePath = join(commonDir, 'info', 'exclude')
    // Directory-only form does not cover symlinks — must still write /node_modules.
    writeFileSync(excludePath, 'node_modules/\n')

    await ensureWorktreeSharedSymlinkExclude(worktree, ['node_modules'])
    expect(readFileSync(excludePath, 'utf8')).toContain('/node_modules\n')
    git(worktree, ['check-ignore', '-q', 'node_modules'])
  })

  posixIt('skips real directories that already match directory-only ignore', async () => {
    const primary = join(root, 'primary')
    initRepoWithCommit(primary)
    mkdirSync(join(primary, 'node_modules'))

    await ensureWorktreeSharedSymlinkExclude(primary, ['node_modules'])

    const commonDir = (await resolveWorktreeGitCommonDir(primary))!
    // Why: no symlink → no exclude write; git's default exclude may still exist empty/commented.
    let exclude = ''
    try {
      exclude = readFileSync(join(commonDir, 'info', 'exclude'), 'utf8')
    } catch {
      // absent is fine
    }
    expect(exclude).not.toContain('node_modules')
  })

  posixIt(
    'shared-path materialize writes exclude so git add -A cannot stage the absolute-path symlink',
    async () => {
      const primary = join(root, 'primary')
      initRepoWithCommit(primary)
      const worktree = join(root, 'worktree')
      git(primary, ['worktree', 'add', '--quiet', '-b', 'feature', worktree])

      mkdirSync(join(primary, 'node_modules'))
      writeFileSync(join(primary, 'node_modules', 'pkg.js'), 'secret')

      // Why: exclude widening is scoped to sharedDirectories (createWorktreeSharedPaths),
      // not every generic linked path.
      await createWorktreeSharedPaths(primary, worktree, ['node_modules'], {
        platform: 'linux'
      })

      expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(true)
      git(worktree, ['check-ignore', '-q', 'node_modules'])

      git(worktree, ['add', '-A'])
      const porcelain = git(worktree, ['status', '--porcelain'])
      expect(porcelain).not.toMatch(/(^|\n)A\s+node_modules(\n|$)/)
      expect(porcelain).not.toMatch(/(^|\n)\?\?\s+node_modules(\n|$)/)

      // Why: the staged-index path must not hold a mode-120000 absolute blob.
      expect(() => git(worktree, ['ls-files', '-s', '--', 'node_modules'])).not.toThrow()
      const lsFiles = git(worktree, ['ls-files', '-s', '--', 'node_modules']).trim()
      expect(lsFiles).toBe('')
    }
  )
})
