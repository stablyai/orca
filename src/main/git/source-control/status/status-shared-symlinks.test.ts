import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorkerChildModule from '../../../worker-thread-child-process/worker-thread-child-process'
import { getStatus } from './status-read'

// The process worker's entry is build output absent from src/; keep Windows launches on the direct spawn.
vi.mock(
  '../../../worker-thread-child-process/worker-thread-child-process',
  async (importOriginal) => ({
    ...(await importOriginal<typeof WorkerChildModule>()),
    canSpawnOnWorkerThread: () => false,
    whenSpawnWorkerReady: async () => false
  })
)

// Directory-only ignore rules cannot hide shared symlinks; status must filter configured links.
const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const windows = process.platform === 'win32'

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
    git(['add', '-A'], primary)
    git(['commit', '-qm', 'init'], primary)
    mkdirSync(join(primary, 'node_modules'))
    git(['worktree', 'add', '-q', worktree, '-b', 'feature'], primary)
    // Windows needs elevation or Developer Mode for symlinks, so Orca links shared directories as junctions; POSIX ignores the type.
    symlinkSync(join(primary, 'node_modules'), join(worktree, 'node_modules'), 'junction')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('still reports a genuine untracked file alongside a shared symlink', async () => {
    writeFileSync(join(worktree, 'scratch.txt'), 'unsaved work\n')

    const status = await getStatus(worktree, { sharedLinkPaths: ['node_modules'] })

    expect(status.entries).toEqual([
      expect.objectContaining({ path: 'scratch.txt', area: 'untracked' })
    ])
  })

  it('keeps a regular file the user created at a configured shared name', async () => {
    writeFileSync(join(worktree, 'notes'), 'user work\n')

    const status = await getStatus(worktree, {
      sharedLinkPaths: ['node_modules', 'notes']
    })

    expect(status.entries).toEqual([expect.objectContaining({ path: 'notes', area: 'untracked' })])
  })

  // A junction cannot target a file.
  it.skipIf(windows)('keeps a modified tracked symlink at a declared shared path', async () => {
    symlinkSync('README.md', join(worktree, 'tracked-link'))
    git(['add', 'tracked-link'], worktree)
    git(['commit', '-qm', 'track link'], worktree)
    unlinkSync(join(worktree, 'tracked-link'))
    symlinkSync('OTHER.md', join(worktree, 'tracked-link'))

    const status = await getStatus(worktree, {
      sharedLinkPaths: ['node_modules', 'tracked-link']
    })

    expect(status.entries).toEqual([
      expect.objectContaining({ path: 'tracked-link', area: 'unstaged' })
    ])
  })

  // Git for Windows walks a junction as a directory, so it never reports the link itself.
  it.skipIf(windows)('keeps a symlink at a path that was never declared shared', async () => {
    symlinkSync(join(primary, 'node_modules'), join(worktree, 'vendor'), 'dir')

    const status = await getStatus(worktree, { sharedLinkPaths: ['node_modules'] })

    expect(status.entries).toEqual([expect.objectContaining({ path: 'vendor', area: 'untracked' })])
  })
})
