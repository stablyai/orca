import type { GitPushTarget, GitWorktreeInfo } from '../../shared/worktree/types'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { Repo } from '../../shared/repo-types'
import { assertWorktreeUnlockedForRemoval } from '../../shared/worktree/removal'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { gitExecFileAsync } from '../git/runner'
import { assertWorktreeCleanForRemoval, listWorktreesStrict, removeWorktree } from '../git/worktree'
import { getWorktreeSharedLinkPaths } from '../git/worktree-shared-directories'
import { runHook, getEffectiveHooks } from '../hooks'
import {
  findExistingWorktreeSymlinkPaths,
  removeWorktreeLinkedPaths
} from '../ipc/worktree-symlinks'
import { cleanupUnusedWorktreePushTargetRemote } from '../ipc/worktree-remote'
import {
  formatWorktreeRemovalError,
  isOrphanCompatiblePreflightError,
  isOrphanedWorktreeError
} from '../ipc/worktree-logic'
import {
  getLocalWorktreePathAccess,
  removeLocalWorktreePath,
  toLocalWorktreeRuntimePath
} from '../local-worktree-filesystem'
import { recoverLocalWindowsWorktreeRemoval } from '../local-worktree-removal-recovery'
import {
  canSafelyRemoveOrphanedWorktreeDirectory,
  findRegisteredDeletableWorktree
} from '../worktree-removal-safety'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeWorktreeRemovalTarget } from './runtime-worktree-selection'

export async function removeRuntimeRegisteredLocalWorktree(args: {
  repo: Repo
  target: RuntimeWorktreeRemovalTarget
  registeredWorktree: GitWorktreeInfo
  removedPushTarget: GitPushTarget | undefined
  store: RuntimeStore
  localOptions: LocalProjectWorktreeGitOptions
  hasLocalOptions: boolean
  force: boolean
  runHooks: boolean
  allowUnverifiedPtyStop: boolean
  deleteBranch: boolean
  acquireWatcherRemoval: (path: string) => Promise<{ finish: (removed: boolean) => Promise<void> }>
  stopPtys: () => Promise<void>
  closeWatchers: (path: string) => Promise<void>
  preserveBranchHead: (
    result: RemoveWorktreeResult | undefined,
    fallbackHead: string | undefined
  ) => RemoveWorktreeResult
  finishRemoval: (
    result: RemoveWorktreeResult | undefined,
    rememberBranch: boolean,
    // Why: re-read after the archive hook, which can move the branch out from under the pre-hook row.
    fallbackHead: string | undefined
  ) => void
}): Promise<RemoveWorktreeResult & { warning?: string }> {
  const { repo, registeredWorktree, localOptions } = args
  const canonicalPath = registeredWorktree.path
  const hooks = getEffectiveHooks(repo)
  let warning: string | undefined
  if (hooks?.scripts.archive && args.runHooks) {
    const result = await runHook(
      'archive',
      canonicalPath,
      repo,
      undefined,
      args.hasLocalOptions ? localOptions : undefined
    )
    if (!result.success) {
      console.error(`[hooks] archive hook failed for ${canonicalPath}:`, result.output)
    }
  } else if (hooks?.scripts.archive) {
    warning = `orca.yaml archive hook skipped for ${canonicalPath}; pass --run-hooks to run it.`
    console.warn(`[hooks] ${warning}`)
  }

  const refreshedWorktrees = args.hasLocalOptions
    ? await listWorktreesStrict(repo.path, localOptions)
    : await listWorktreesStrict(repo.path)
  const refreshed = findRegisteredDeletableWorktree(repo.path, canonicalPath, refreshedWorktrees)
  if (!refreshed) {
    throw new Error(
      `Worktree registration changed during deletion: ${canonicalPath}. Retry deletion.`
    )
  }
  try {
    assertWorktreeUnlockedForRemoval(refreshed)
  } catch (error) {
    throw new Error(formatWorktreeRemovalError(error, canonicalPath, args.force))
  }

  const linkedPaths = getWorktreeSharedLinkPaths(repo)
  const ignoredLinkedPaths = args.force
    ? []
    : await findExistingWorktreeSymlinkPaths(canonicalPath, linkedPaths)
  try {
    await (args.hasLocalOptions
      ? assertWorktreeCleanForRemoval(canonicalPath, args.force, {
          ...localOptions,
          ...(ignoredLinkedPaths.length > 0 ? { ignoredUntrackedPaths: ignoredLinkedPaths } : {})
        })
      : ignoredLinkedPaths.length > 0
        ? assertWorktreeCleanForRemoval(canonicalPath, args.force, {
            ignoredUntrackedPaths: ignoredLinkedPaths
          })
        : assertWorktreeCleanForRemoval(canonicalPath, args.force))
  } catch (error) {
    if (!isOrphanCompatiblePreflightError(error)) {
      throw new Error(formatWorktreeRemovalError(error, canonicalPath, args.force))
    }
  }

  let removalResult: RemoveWorktreeResult | undefined
  const gate = await args.acquireWatcherRemoval(canonicalPath)
  let completed = false
  try {
    await args.stopPtys()
    if (linkedPaths.length > 0) {
      await removeWorktreeLinkedPaths(canonicalPath, linkedPaths)
    }
    try {
      removalResult = args.preserveBranchHead(
        await removeWorktree(repo.path, canonicalPath, args.force, {
          ...(!args.deleteBranch ? { deleteBranch: args.deleteBranch } : {}),
          knownRemovedWorktree: refreshed,
          ...localOptions
        }),
        refreshed.head
      )
    } catch (error) {
      const recovered = await recoverLocalWindowsWorktreeRemoval({
        error,
        force: args.force,
        canonicalWorktreePath: canonicalPath,
        repoPath: repo.path,
        localWorktreeGitOptions: localOptions,
        registeredWorktree: refreshed,
        deleteBranch: args.deleteBranch,
        closeWatcher: args.closeWatchers
      })
      if (recovered) {
        removalResult = recovered
        completed = true
      } else if (isOrphanedWorktreeError(error)) {
        await cleanupOrphanedDirectory(repo, canonicalPath, localOptions, args.closeWatchers)
        await gitExecFileAsync(['worktree', 'prune'], { cwd: repo.path, ...localOptions }).catch(
          () => {}
        )
        await cleanupPushTarget(args)
        args.finishRemoval(undefined, false, refreshed.head)
        completed = true
        return warning ? { warning } : {}
      } else {
        throw new Error(formatWorktreeRemovalError(error, canonicalPath, args.force))
      }
    }
    completed = true
  } finally {
    await gate.finish(completed)
  }
  await cleanupPushTarget(args)
  args.finishRemoval(removalResult, true, refreshed.head)
  return { ...removalResult, ...(warning ? { warning } : {}) }
}

async function cleanupOrphanedDirectory(
  repo: Repo,
  path: string,
  options: LocalProjectWorktreeGitOptions,
  closeWatchers: (path: string) => Promise<void>
): Promise<void> {
  const access = getLocalWorktreePathAccess(options)
  if (
    await canSafelyRemoveOrphanedWorktreeDirectory(
      toLocalWorktreeRuntimePath(path, options),
      toLocalWorktreeRuntimePath(repo.path, options),
      access.statPath,
      access.readPath
    )
  ) {
    await closeWatchers(path)
    await removeLocalWorktreePath(path, options).catch(() => {})
  } else {
    console.warn(`[worktrees] Refusing recursive cleanup for unproven worktree directory: ${path}`)
  }
}

async function cleanupPushTarget(
  args: Parameters<typeof removeRuntimeRegisteredLocalWorktree>[0]
): Promise<void> {
  await cleanupUnusedWorktreePushTargetRemote(
    args.repo.path,
    args.target.id,
    args.removedPushTarget,
    args.store,
    args.localOptions
  )
}
