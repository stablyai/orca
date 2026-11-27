// Real Git: a died `git worktree add` leaves a lock that must not block deleting its missing checkout (#17654).
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { installRealWorkerThreadChildProcesses } from '../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { removeTree } from '../../../shared/file-write/windows-transient-lock-removal'
import { listWorktreesStrict } from '../../git/worktrees/catalog/worktree-listing'
import { areWorktreePathsEqual } from '../../git/worktrees/catalog/worktree-path-comparison'
import { removeWorktree } from '../../git/worktrees/removal/worktree-removal'
import { findRegisteredWorktreeReleasingDiedAddLock } from './died-worktree-add-lock'
import { CLIENT_REMOVAL_HOME } from './worktree-removal-home-guard'

const execFileAsync = promisify(execFile)
installRealWorkerThreadChildProcesses()

let scratchDir = ''
let repoPath = ''
let worktreePath = ''

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

async function findForRemoval() {
  const row = await findRegisteredWorktreeReleasingDiedAddLock(
    repoPath,
    worktreePath,
    await listWorktreesStrict(repoPath),
    CLIENT_REMOVAL_HOME,
    {}
  )
  if (!row) {
    throw new Error('worktree is not registered')
  }
  return row
}

beforeEach(async () => {
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-died-add-lock-')))
  repoPath = join(scratchDir, 'repo')
  worktreePath = join(scratchDir, 'feature')
  await mkdir(repoPath, { recursive: true })
  await git(['init', '-q'], repoPath)
  await git(['config', 'user.email', 'removal@example.invalid'], repoPath)
  await git(['config', 'user.name', 'Worktree Removal'], repoPath)
  await git(['config', 'maintenance.auto', 'false'], repoPath)
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'], repoPath)
  await git(['commit', '-qm', 'seed'], repoPath)
  await git(['worktree', 'add', '-q', worktreePath, '-b', 'feature'], repoPath)
})

afterEach(async () => {
  await removeTree(scratchDir)
})

it('releases a died add lock on a missing checkout so removal completes', async () => {
  await git(['worktree', 'lock', '--reason', 'initializing', worktreePath], repoPath)
  await removeTree(worktreePath)

  const released = await findForRemoval()
  expect(released.locked).toBeUndefined()
  await removeWorktree(repoPath, worktreePath, false, { knownRemovedWorktree: released })

  expect(
    (await listWorktreesStrict(repoPath)).some((worktree) =>
      areWorktreePathsEqual(worktree.path, worktreePath)
    )
  ).toBe(false)
})

it('keeps every other lock, and an add lock whose checkout still exists', async () => {
  await git(['worktree', 'lock', '--reason', 'initializing', worktreePath], repoPath)
  expect((await findForRemoval()).lockReason).toBe('initializing')

  await git(['worktree', 'unlock', worktreePath], repoPath)
  await git(['worktree', 'lock', '--reason', 'portable volume', worktreePath], repoPath)
  await removeTree(worktreePath)
  const portable = await findForRemoval()
  expect(portable.lockReason).toBe('portable volume')
  await expect(
    removeWorktree(repoPath, worktreePath, true, { knownRemovedWorktree: portable })
  ).rejects.toThrow('Worktree is locked by Git. Lock reason: portable volume.')
})
