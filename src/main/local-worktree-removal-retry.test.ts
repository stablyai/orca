import { installRealWorkerThreadChildProcesses } from './worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanupLocalOrphanedWorktreeDirectory } from './local-orphaned-worktree-cleanup'
import { recoverLocalWorktreeRemoval } from './local-worktree-removal-recovery'

const exec = promisify(execFile)
let root = ''
let repo = ''
let checkout = ''
let head = ''

async function git(args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: repo })).stdout.trim()
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-removal-recovery-')))
  repo = join(root, 'repo')
  checkout = join(root, 'feature')
  await mkdir(repo)
  await git(['init', '-q'])
  await git(['config', 'user.name', 'Test'])
  await git(['config', 'user.email', 'test@example.invalid'])
  await git(['commit', '--allow-empty', '-qm', 'initial'])
  await git(['worktree', 'add', '-qb', 'feature', checkout])
  head = await git(['rev-parse', 'feature'])
  const link = await readFile(join(checkout, '.git'), 'utf8')
  await rm(link.trim().replace(/^gitdir: /, ''), { recursive: true })
  await writeFile(join(checkout, 'leftover.txt'), 'partial deletion')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function recover(closeWatcher: () => Promise<void> = async () => {}) {
  return recoverLocalWorktreeRemoval({
    error: new Error('Directory not empty'),
    force: false,
    canonicalWorktreePath: checkout,
    repoPath: repo,
    localWorktreeGitOptions: {},
    registeredWorktree: { branch: 'refs/heads/feature', head },
    deleteBranch: true,
    closeWatcher
  })
}

it('finishes a proven partial removal and preserves its branch on every platform', async () => {
  expect(await recover()).toEqual({ preservedBranch: { branchName: 'feature', head } })
  expect(existsSync(checkout)).toBe(false)
  expect(await git(['rev-parse', 'feature'])).toBe(head)
})

it('keeps a foreign checkout that replaced a POSIX removal leftover', async () => {
  if (process.platform === 'win32') {
    return
  }
  await rm(join(checkout, '.git'))
  await mkdir(join(checkout, '.git'))
  expect(await recover()).toBeUndefined()
  expect(await readFile(join(checkout, 'leftover.txt'), 'utf8')).toBe('partial deletion')
})

it('never removes a registered worktree nested inside a leftover', async () => {
  const nested = join(checkout, 'nested')
  await mkdir(dirname(nested), { recursive: true })
  await git(['worktree', 'add', '-qb', 'nested', nested])
  await expect(recover()).rejects.toThrow(/another registered worktree/i)
  expect(existsSync(join(nested, '.git'))).toBe(true)
  expect(await readFile(join(checkout, 'leftover.txt'), 'utf8')).toBe('partial deletion')
})

it('preserves a checkout registered while watchers are closing', async () => {
  await recover(async () => {
    await rm(checkout, { recursive: true })
    await git(['worktree', 'add', '-qb', 'replacement', checkout])
    await writeFile(join(checkout, 'unsaved.txt'), 'keep me')
  })
  expect(await readFile(join(checkout, 'unsaved.txt'), 'utf8')).toBe('keep me')
  expect(await git(['worktree', 'list', '--porcelain'])).toContain(checkout)
})

it('does not prune another checkout on a temporarily unmounted volume', async () => {
  const other = join(root, 'other')
  await git(['worktree', 'add', '-qb', 'other', other])
  await rename(other, join(root, 'unmounted'))
  await recover()
  expect(await git(['worktree', 'list', '--porcelain'])).toContain(other)
})

it('rechecks a retry after its watcher teardown registers a replacement', async () => {
  await expect(
    cleanupLocalOrphanedWorktreeDirectory(repo, checkout, {}, async () => {
      await rm(checkout, { recursive: true })
      await git(['worktree', 'add', '-qb', 'replacement', checkout])
      await writeFile(join(checkout, 'unsaved.txt'), 'keep me')
    })
  ).rejects.toThrow(/directory remains/)
  expect(await readFile(join(checkout, 'unsaved.txt'), 'utf8')).toBe('keep me')
})

installRealWorkerThreadChildProcesses()
