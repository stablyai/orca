// Real Git: a checkout swapped in at the path must survive both Git's delete and recovery.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { installRealWorkerThreadChildProcesses } from '../../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { removeTree } from '../../../../shared/file-write/windows-transient-lock-removal'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { readCheckoutMarkerIdentity } from '../../../workspaces/removal/worktree-removal-gitdir-identity'
import { assertCheckoutNotReplaced } from '../../../workspaces/removal/worktree-removal-leftover'
import { recoverPartialLocalWorktreeRemoval } from '../../../workspaces/removal/local-worktree-removal-recovery'
import { finishRuntimeLocalWorktreeRemoval } from './runtime-registered-local-worktree-removal'

const execFileAsync = promisify(execFile)
installRealWorkerThreadChildProcesses()

let scratchDir = ''

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await git(['init', '-q'], path)
  await git(['config', 'user.email', 'removal@example.invalid'], path)
  await git(['config', 'user.name', 'Worktree Removal'], path)
  await git(['config', 'maintenance.auto', 'false'], path)
  await writeFile(join(path, 'seed.txt'), 'seed\n')
  await git(['add', '-A'], path)
  await git(['commit', '-qm', 'seed'], path)
}

beforeEach(async () => {
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-removal-identity-')))
})

afterEach(async () => {
  await removeTree(scratchDir)
})

async function replaceWithOtherRepoCheckout(): Promise<{
  repoPath: string
  worktreePath: string
  record: { worktreePath: string; gitdir: string | undefined }
}> {
  const repoPath = join(scratchDir, 'repo')
  const otherRepoPath = join(scratchDir, 'other')
  const worktreePath = join(scratchDir, 'checkout')
  await initRepo(repoPath)
  await initRepo(otherRepoPath)
  await git(['worktree', 'add', '-q', worktreePath, '-b', 'feature'], repoPath)
  const record = { worktreePath, gitdir: await readCheckoutMarkerIdentity(worktreePath) }
  // The accepted registration is gone and another repo's checkout now sits at the path.
  await git(['worktree', 'remove', '--force', worktreePath], repoPath)
  await git(['worktree', 'add', '-q', worktreePath, '-b', 'other'], otherRepoPath)
  await writeFile(join(worktreePath, 'work.txt'), 'unsaved\n')
  return { repoPath, worktreePath, record }
}

it('keeps another repo checkout recreated at the path instead of recovering into it', async () => {
  const { repoPath, worktreePath, record } = await replaceWithOtherRepoCheckout()
  const accepted: GitWorktreeInfo = {
    path: worktreePath,
    branch: 'refs/heads/feature',
    head: '',
    isMainWorktree: false,
    isBare: false
  }

  await expect(
    finishRuntimeLocalWorktreeRemoval(
      {
        repo: { id: 'repo', path: repoPath, displayName: 'repo', badgeColor: '', addedAt: 0 },
        target: { id: 'repo::feature' },
        removedPushTarget: undefined,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refusal throws before any store read.
        store: {} as RuntimeStore,
        localOptions: {},
        force: true,
        deleteBranch: false,
        closeWatchers: async () => {},
        preserveBranchHead: (value) => value ?? {},
        finishRemoval: async () => {}
      },
      accepted,
      { finish: async () => {} },
      undefined,
      () => assertCheckoutNotReplaced(record)
    )
  ).rejects.toThrow()

  expect(existsSync(join(worktreePath, 'work.txt'))).toBe(true)
})

it('rechecks identity right before recovery deletes a leftover', async () => {
  const { repoPath, worktreePath, record } = await replaceWithOtherRepoCheckout()

  await expect(
    recoverPartialLocalWorktreeRemoval({
      error: new Error('git worktree remove failed'),
      force: true,
      canonicalWorktreePath: worktreePath,
      repoPath,
      localWorktreeGitOptions: {},
      registeredWorktree: { branch: 'refs/heads/feature', head: '' },
      deleteBranch: false,
      closeWatcher: async () => {},
      beforeLeftoverDelete: () => assertCheckoutNotReplaced(record)
    })
  ).rejects.toThrow()

  expect(existsSync(join(worktreePath, 'work.txt'))).toBe(true)
})
