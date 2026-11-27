// Real Git verifies the prune guard: it keeps a record the other Git wrote, and runs no prune
// whose records it could not read or lock.
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTree } from '../../../../shared/file-write/windows-transient-lock-removal'

import { pruneGitWorktrees, readWorktreeLinks } from './worktree-prune-guard'

const execFileAsync = promisify(execFile)

const fault = vi.hoisted(() => ({ syscall: '', path: '', code: '' }))

// One syscall, for one path, fails the way a dead distro share fails it; every other call is real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  const fails = (syscall: string, path: unknown): boolean =>
    fault.syscall === syscall && String(path).endsWith(fault.path)
  // Fails only the records folder's own listing, so a missing-folder check still reads its parent.
  const readdir = (...args: Parameters<typeof actual.readdir>) =>
    fails('readdir', args[0]) && String(args[0]).replaceAll('\\', '/').endsWith('/worktrees')
      ? Promise.reject(Object.assign(new Error('share unavailable'), { code: fault.code }))
      : actual.readdir(...args)
  const writeFile = (...args: Parameters<typeof actual.writeFile>) =>
    fails('writeFile', args[0])
      ? Promise.reject(Object.assign(new Error('share refused the write'), { code: fault.code }))
      : actual.writeFile(...args)
  return { ...actual, readdir, writeFile }
})

let scratchDir = ''
let repoPath = ''
let adminRoot = ''
let adminEntry = ''

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

beforeEach(async () => {
  // Canonicalize macOS /var temp paths to match Git's /private/var output.
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-prune-guard-')))
  repoPath = join(scratchDir, 'repo')
  await mkdir(repoPath, { recursive: true })
  await git(['init', '-q'], repoPath)
  await git(['config', 'user.email', 'prune@example.invalid'], repoPath)
  await git(['config', 'user.name', 'Prune Guard'], repoPath)
  // Disable detached maintenance that could race fixture teardown.
  await git(['config', 'maintenance.auto', 'false'], repoPath)
  await git(['config', 'gc.auto', '0'], repoPath)
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'], repoPath)
  await git(['commit', '-qm', 'seed'], repoPath)
  const worktreePath = join(scratchDir, 'feature')
  await git(['worktree', 'add', '-q', worktreePath, '-b', 'feature'], repoPath)
  await removeTree(worktreePath)
  // Stale, and linked the way the other Git spells a path: this Git would prune it.
  adminRoot = join(repoPath, '.git', 'worktrees')
  adminEntry = join(adminRoot, readdirSync(adminRoot)[0])
  await writeFile(join(adminEntry, 'gitdir'), '/prune-guard-gone/feature/.git\n')
})

afterEach(async () => {
  fault.syscall = ''
  fault.path = ''
  fault.code = ''
  await removeTree(scratchDir)
})

describe('worktree prune guard', () => {
  it('keeps a record the other Git wrote, and removes only its own lock', async () => {
    await pruneGitWorktrees({ cwd: repoPath }, 'win32')

    expect(existsSync(join(adminEntry, 'gitdir'))).toBe(true)
    expect(existsSync(join(adminEntry, 'locked'))).toBe(false)

    // The record is one a prune deletes: unguarded, Git drops it.
    await git(['worktree', 'prune'], repoPath)
    expect(existsSync(adminEntry)).toBe(false)
  })

  it('runs no prune while the records cannot be listed', async () => {
    fault.syscall = 'readdir'
    fault.path = join('.git', 'worktrees')
    fault.code = 'EIO'

    await expect(pruneGitWorktrees({ cwd: repoPath }, 'win32')).rejects.toMatchObject({
      code: 'EIO'
    })
    expect(existsSync(join(adminEntry, 'gitdir'))).toBe(true)
  })

  it('runs no prune while a foreign record cannot be locked', async () => {
    fault.syscall = 'writeFile'
    fault.path = 'locked'
    fault.code = 'EACCES'

    await expect(pruneGitWorktrees({ cwd: repoPath }, 'win32')).rejects.toMatchObject({
      code: 'EACCES'
    })
    expect(existsSync(join(adminEntry, 'gitdir'))).toBe(true)
  })

  it('reads no records only from a missing folder under a readable parent', async () => {
    const noWorktrees = join(repoPath, '.git', 'worktrees')
    await removeTree(adminRoot)

    await expect(readWorktreeLinks(noWorktrees)).resolves.toEqual([])
    await expect(readWorktreeLinks(join(scratchDir, 'gone', 'worktrees'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses a missing records folder under a parent it cannot list',
    async () => {
      const gitDir = join(repoPath, '.git')
      await removeTree(adminRoot)
      // 0o111: the child readdir reads ENOENT, so the missing-folder check must hit the parent's EACCES.
      chmodSync(gitDir, 0o111)
      try {
        await expect(readWorktreeLinks(join(gitDir, 'worktrees'))).rejects.toMatchObject({
          code: 'EACCES'
        })
      } finally {
        chmodSync(gitDir, 0o755)
      }
    }
  )
})
