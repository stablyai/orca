import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getStatus } from './status'

// Directory-only ignore rules cannot hide shared symlinks; status must filter configured links.
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

  it.each(['./node_modules', 'node_modules/'])(
    'drops the shared symlink when the setting spells it %s',
    async (sharedPath) => {
      const status = await getStatus(worktree, { sharedLinkPaths: [sharedPath] })

      expect(status.entries).toEqual([])
    }
  )

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

  it('keeps a regular file the user created at a configured shared name', async () => {
    writeFileSync(join(worktree, 'notes'), 'user work\n')

    const status = await getStatus(worktree, {
      sharedLinkPaths: ['node_modules', 'notes']
    })

    expect(status.entries).toEqual([expect.objectContaining({ path: 'notes', area: 'untracked' })])
  })

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
