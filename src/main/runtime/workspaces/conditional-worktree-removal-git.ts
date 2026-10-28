import { lstat, realpath, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { gitExecFileAsync } from '../../git/runner'
import {
  assertWorktreeCleanForRemoval,
  listWorktreesStrict,
  removeWorktree
} from '../../git/worktree'
import { findRegisteredDeletableWorktree } from '../../worktree-removal-safety'
import { assertWorktreeUnlockedForRemoval } from '../../../shared/worktree/removal'
import type { ConditionalRemovalExpected } from '../../../shared/rpc-contract/conditional-worktree-removal'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { CLIENT_REMOVAL_HOME } from '../../worktree-removal-home-guard'

export async function physicalIdentity(path: string) {
  const canonical = await realpath(path)
  const info = await lstat(canonical, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('identity_changed')
  }
  return { path: canonical, device: info.dev.toString(), inode: info.ino.toString() }
}

export async function conditionalGit(
  repoPath: string,
  args: string[],
  conditionalRemovalToken?: symbol
) {
  return (
    await gitExecFileAsync(args, {
      cwd: repoPath,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      conditionalRemovalToken
    })
  ).stdout.trim()
}

export async function verifyConditionalGitIdentity(
  repoPath: string,
  expected: ConditionalRemovalExpected
): Promise<GitWorktreeInfo> {
  const worktrees = await listWorktreesStrict(repoPath, { timeout: 5000 })
  const registered = findRegisteredDeletableWorktree(
    repoPath,
    expected.checkout.path,
    worktrees,
    CLIENT_REMOVAL_HOME
  )
  if (!registered || registered.head !== expected.head || registered.branch !== expected.branch) {
    throw new Error('identity_changed')
  }
  assertWorktreeUnlockedForRemoval(registered)
  const gitPath = async (flag: string) => {
    const result = await conditionalGit(expected.checkout.path, ['rev-parse', flag])
    return physicalIdentity(isAbsolute(result) ? result : resolve(expected.checkout.path, result))
  }
  const actual = {
    checkout: await physicalIdentity(expected.checkout.path),
    commonGitDirectory: await gitPath('--git-common-dir'),
    adminDirectory: await gitPath('--git-dir')
  }
  for (const key of ['checkout', 'commonGitDirectory', 'adminDirectory'] as const) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) {
      throw new Error('identity_changed')
    }
  }
  if (
    (await conditionalGit(expected.checkout.path, ['rev-parse', '--verify', 'HEAD'])) !==
      expected.head ||
    (await conditionalGit(expected.checkout.path, ['symbolic-ref', '-q', 'HEAD'])) !==
      expected.branch
  ) {
    throw new Error('identity_changed')
  }
  return registered
}

export async function verifyConditionalGitClean(
  expected: ConditionalRemovalExpected
): Promise<void> {
  await assertWorktreeCleanForRemoval(expected.checkout.path, false, { timeout: 5000 })
  const status = await conditionalGit(expected.checkout.path, [
    'status',
    '--porcelain',
    '-z',
    '--ignored',
    '--untracked-files=all',
    '--ignore-submodules=none'
  ])
  if (status) {
    throw new Error('git_not_clean')
  }
  for (const directory of [expected.adminDirectory.path, expected.commonGitDirectory.path]) {
    const entries = await readdir(directory)
    if (
      entries.length > 512 ||
      entries.some(
        (entry) =>
          entry.endsWith('.lock') ||
          /^(MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|BISECT_LOG|rebase-merge|rebase-apply|sequencer)$/.test(
            entry
          )
      )
    ) {
      throw new Error('git_operation_pending')
    }
  }
  const branchLock = join(expected.commonGitDirectory.path, `${expected.branch}.lock`)
  try {
    await lstat(branchLock)
    throw new Error('git_operation_pending')
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }
  if (
    (await conditionalGit(expected.checkout.path, ['rev-parse', '--verify', '@{upstream}'])) !==
    expected.head
  ) {
    throw new Error('git_not_clean')
  }
}

export async function removeConditionalGitCheckout(
  repoPath: string,
  expected: ConditionalRemovalExpected,
  worktree: GitWorktreeInfo,
  conditionalRemovalToken: symbol
): Promise<void> {
  await removeWorktree(repoPath, expected.checkout.path, false, {
    deleteBranch: false,
    conditionalRemovalToken,
    refuseFilesystemFallback: true,
    knownRemovedWorktree: worktree,
    timeout: 30000
  })
}
