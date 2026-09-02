import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getStatus } from './status'

// Why: `node_modules/` is a directory-only ignore rule. It matches the primary
// checkout's real directory but never the worktree's symlink, so Git reports the
// link as untracked forever — a phantom row in the diff and a permanently dirty
// worktree. Status has to drop it; nothing else can.
const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

describe('getStatus shared symlink exclusion', () => {
  let root: string
  let primary: string
  let worktree: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-status-shared-'))
    primary = join(root, 'primary')
    worktree = join(root, 'worktree')
    mkdirSync(primary)
    git(['init', '-q', '-b', 'main'], primary)
    git(['config', 'user.email', 'test@example.com'], primary)
    git(['config', 'user.name', 'Test'], primary)
    writeFileSync(join(primary, '.gitignore'), 'node_modules/\n')
    writeFileSync(join(primary, 'README.md'), '# tracked\n')
    writeFileSync(join(primary, 'OTHER.md'), '# other\n')
    symlinkSync('README.md', join(primary, 'tracked-link'))
    git(['add', '-A'], primary)
    git(['commit', '-qm', 'init'], primary)
    mkdirSync(join(primary, 'node_modules'))
    git(['worktree', 'add', '-q', worktree, '-b', 'feature'], primary)
    symlinkSync(join(primary, 'node_modules'), join(worktree, 'node_modules'), 'dir')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  // Why: guards the premise of the whole fix. If Git ever reported the symlink
  // as `node_modules/` (as it does for a real untracked directory) the path
  // comparison below would silently miss and the exclusion would do nothing.
  it('Git reports the shared symlink as untracked, without a trailing slash', async () => {
    const status = await getStatus(worktree)

    expect(status.entries).toEqual([
      expect.objectContaining({ path: 'node_modules', area: 'untracked' })
    ])
  })

  it('drops the shared symlink when it is declared shared', async () => {
    const status = await getStatus(worktree, { sharedLinkPaths: ['node_modules'] })

    expect(status.entries).toEqual([])
  })

  // The negative control that matters: real work must never be hidden.
  it('still reports a genuine untracked file alongside a shared symlink', async () => {
    writeFileSync(join(worktree, 'scratch.txt'), 'unsaved work\n')

    const status = await getStatus(worktree, { sharedLinkPaths: ['node_modules'] })

    expect(status.entries).toEqual([
      expect.objectContaining({ path: 'scratch.txt', area: 'untracked' })
    ])
  })

  it('still reports a modified tracked file alongside a shared symlink', async () => {
    writeFileSync(join(worktree, 'README.md'), '# edited\n')

    const status = await getStatus(worktree, { sharedLinkPaths: ['node_modules'] })

    expect(status.entries).toEqual([
      expect.objectContaining({ path: 'README.md', area: 'unstaged' })
    ])
  })

  // Why: the configured name alone must not hide anything — only a real symlink.
  // `vendor` is not gitignored, so Git genuinely reports it and the filter is
  // the only thing that could wrongly drop it.
  it('keeps a regular directory the user created at a configured shared name', async () => {
    mkdirSync(join(worktree, 'vendor'))
    writeFileSync(join(worktree, 'vendor', 'real.txt'), 'user work\n')

    const status = await getStatus(worktree, {
      sharedLinkPaths: ['node_modules', 'vendor']
    })

    expect(status.entries).toEqual([
      expect.objectContaining({ path: 'vendor/real.txt', area: 'untracked' })
    ])
  })

  // Why: the exact discriminator for "configured AND really a symlink". The path
  // matches a declared name exactly, so only the symlink check keeps the user's
  // file visible.
  it('keeps a regular file the user created at a configured shared name', async () => {
    writeFileSync(join(worktree, 'notes'), 'user work\n')

    const status = await getStatus(worktree, {
      sharedLinkPaths: ['node_modules', 'notes']
    })

    expect(status.entries).toEqual([expect.objectContaining({ path: 'notes', area: 'untracked' })])
  })

  // Why: only *untracked* entries are Orca's artifacts. A symlink Git tracks is
  // versioned content, so an edit to it is the user's work even when the path is
  // declared shared — dropping it would hide a committable change.
  it('keeps a modified tracked symlink at a declared shared path', async () => {
    unlinkSync(join(worktree, 'tracked-link'))
    symlinkSync('OTHER.md', join(worktree, 'tracked-link'))

    const status = await getStatus(worktree, {
      sharedLinkPaths: ['node_modules', 'tracked-link']
    })

    expect(status.entries).toEqual([
      expect.objectContaining({ path: 'tracked-link', area: 'unstaged' })
    ])
  })

  // Why: these are the names a byte-for-byte path comparison is most likely to
  // get wrong — a space breaks naive whitespace splitting, and non-ASCII is what
  // Git C-quotes unless the reader opts out.
  it('drops shared symlinks whose names have a space or non-ASCII characters', async () => {
    const names = ['my shared dir', 'ライブラリ']
    for (const name of names) {
      symlinkSync(join(primary, 'node_modules'), join(worktree, name), 'dir')
    }

    const status = await getStatus(worktree, { sharedLinkPaths: ['node_modules', ...names] })

    expect(status.entries).toEqual([])
  })

  it('keeps a symlink at a path that was never declared shared', async () => {
    symlinkSync(join(primary, 'node_modules'), join(worktree, 'vendor'), 'dir')

    const status = await getStatus(worktree, { sharedLinkPaths: ['node_modules'] })

    expect(status.entries).toEqual([expect.objectContaining({ path: 'vendor', area: 'untracked' })])
  })
})
