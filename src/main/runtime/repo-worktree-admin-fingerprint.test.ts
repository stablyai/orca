// Real-binary coverage: the fingerprint's whole job is to predict what `git worktree list` would
// report, so a mocked filesystem would only prove the assumptions, not the Git layout they model.
// Also listed in pr.yml's Windows boundary step: reading Git's admin layout directly depends on
// Windows path resolution, CRLF in `HEAD`/`gitdir`/`commondir`, and whether `worktree move`/`lock`
// and deleting a live checkout behave as they do on POSIX. The Linux shards cannot reach any of it.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRepoWorktreeAdminFingerprint } from './repo-worktree-admin-fingerprint'

const execFileAsync = promisify(execFile)

let scratchDir = ''
let repoPath = ''
let worktreePath = ''

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

async function fingerprint(path = repoPath): Promise<string | null> {
  return await readRepoWorktreeAdminFingerprint(path)
}

beforeEach(async () => {
  // realpath: macOS hands out /var/... temp paths while Git records /private/var/... in `gitdir`.
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-worktree-fingerprint-')))
  repoPath = join(scratchDir, 'repo')
  worktreePath = join(scratchDir, 'trees', 'feature')
  await mkdir(repoPath, { recursive: true })
  await mkdir(join(scratchDir, 'trees'), { recursive: true })
  await git(['init', '-q'], repoPath)
  await git(['config', 'user.email', 'fingerprint@example.invalid'], repoPath)
  await git(['config', 'user.name', 'Fingerprint'], repoPath)
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'], repoPath)
  await git(['commit', '-qm', 'seed'], repoPath)
  await git(['worktree', 'add', '-q', worktreePath, '-b', 'feature'], repoPath)
})

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true })
})

describe('readRepoWorktreeAdminFingerprint', () => {
  it('is stable while nothing changes', async () => {
    const first = await fingerprint()
    expect(first).not.toBeNull()
    expect(await fingerprint()).toBe(first)
  })

  it('changes when a worktree is added', async () => {
    const before = await fingerprint()
    await git(
      ['worktree', 'add', '-q', join(scratchDir, 'trees', 'second'), '-b', 'second'],
      repoPath
    )
    expect(await fingerprint()).not.toBe(before)
  })

  it('changes when a worktree is removed', async () => {
    const before = await fingerprint()
    await git(['worktree', 'remove', worktreePath], repoPath)
    expect(await fingerprint()).not.toBe(before)
  })

  it('changes when a worktree directory is deleted outside Git', async () => {
    // The admin dir is untouched by `rm -rf`, but the row's `prunable` flag flips.
    const before = await fingerprint()
    await rm(worktreePath, { recursive: true, force: true })
    expect(await fingerprint()).not.toBe(before)
  })

  it('changes when a worktree is moved', async () => {
    const before = await fingerprint()
    await git(['worktree', 'move', worktreePath, join(scratchDir, 'trees', 'moved')], repoPath)
    expect(await fingerprint()).not.toBe(before)
  })

  it('changes when a worktree is locked', async () => {
    const before = await fingerprint()
    await git(['worktree', 'lock', worktreePath], repoPath)
    expect(await fingerprint()).not.toBe(before)
  })

  it('changes when a linked worktree switches branch', async () => {
    const before = await fingerprint()
    // A longer ref name keeps the difference visible even on a coarse mtime clock.
    await git(['checkout', '-q', '-b', 'feature-with-a-much-longer-name'], worktreePath)
    expect(await fingerprint()).not.toBe(before)
  })

  it('changes when a linked worktree records a commit', async () => {
    // Committing rewrites refs/heads/feature and leaves HEAD alone, but moves the reported HEAD oid.
    const before = await fingerprint()
    await writeFile(join(worktreePath, 'work.txt'), 'work\n')
    await git(['add', '-A'], worktreePath)
    await git(['commit', '-qm', 'work'], worktreePath)
    expect(await fingerprint()).not.toBe(before)
  })

  it('changes when the main worktree records a commit', async () => {
    const before = await fingerprint()
    await writeFile(join(repoPath, 'more.txt'), 'more\n')
    await git(['add', '-A'], repoPath)
    await git(['commit', '-qm', 'more'], repoPath)
    expect(await fingerprint()).not.toBe(before)
  })

  it('still tracks a tip whose loose ref has been packed away', async () => {
    await git(['pack-refs', '--all'], repoPath)
    const before = await fingerprint()
    await writeFile(join(worktreePath, 'packed.txt'), 'packed\n')
    await git(['add', '-A'], worktreePath)
    await git(['commit', '-qm', 'packed'], worktreePath)
    expect(await fingerprint()).not.toBe(before)
  })

  it('changes when the main worktree switches branch', async () => {
    const before = await fingerprint()
    await git(['checkout', '-q', '-b', 'main-with-a-much-longer-name'], repoPath)
    expect(await fingerprint()).not.toBe(before)
  })

  it('resolves the same admin state from a linked worktree path', async () => {
    // A linked worktree can itself be the registered repo path; both must describe one common dir.
    expect(await fingerprint(worktreePath)).toBe(await fingerprint(repoPath))
  })

  it('reads a bare repo through its own gitdir', async () => {
    const barePath = join(scratchDir, 'bare.git')
    await git(['clone', '-q', '--bare', repoPath, barePath], scratchDir)
    const before = await fingerprint(barePath)
    expect(before).not.toBeNull()
    await git(
      ['worktree', 'add', '-q', join(scratchDir, 'trees', 'from-bare'), '-b', 'bare-tree'],
      barePath
    )
    expect(await fingerprint(barePath)).not.toBe(before)
  })

  it('returns null for a directory that is not a git repo', async () => {
    const plainPath = join(scratchDir, 'plain')
    await mkdir(plainPath, { recursive: true })
    expect(await fingerprint(plainPath)).toBeNull()
  })

  it('returns null for a missing path', async () => {
    expect(await fingerprint(join(scratchDir, 'absent'))).toBeNull()
  })
})
