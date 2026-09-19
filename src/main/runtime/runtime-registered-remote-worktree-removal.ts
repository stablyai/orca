import type { GitPushTarget, GitWorktreeInfo } from '../../shared/worktree/types'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { Repo } from '../../shared/repo-types'
import type { ArchiveHookOverride } from '../../shared/worktree/archive-hook-removal-gate'
import { assertWorktreeUnlockedForRemoval } from '../../shared/worktree/removal'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import { cleanupUnusedWorktreePushTargetRemoteSsh } from '../ipc/worktree-remote'
import { formatWorktreeRemovalError } from '../ipc/worktree-logic'
import {
  getArchiveHooksForRemoval,
  runRemoteArchiveHook
} from '../ipc/worktrees/removal/worktree-archive-hook'
import { gateWorktreeRemovalOnArchiveHook } from '../worktree-archive-hook-gate'
import { findRegisteredDeletableWorktree } from '../worktree-removal-safety'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeWorktreeRemovalTarget } from './runtime-worktree-selection'

export async function removeRuntimeRegisteredRemoteWorktree(args: {
  repo: Repo
  target: RuntimeWorktreeRemovalTarget
  registeredWorktree: GitWorktreeInfo
  removedPushTarget: GitPushTarget | undefined
  store: RuntimeStore
  provider: SshGitProvider
  /** From the resolved removal route; `repo.connectionId!` answered null for an `ssh:`-only row. */
  connectionId: string
  runHooks: boolean
  /** Explicit waiver for a FAILED archive hook. Never implied by `force` — see #19334. */
  allowFailedArchiveHook: boolean
  force: boolean
  allowUnverifiedPtyStop: boolean
  deleteBranch: boolean
  acquireWatcherRemoval: (
    path: string,
    connectionId: string
  ) => Promise<{ finish: (removed: boolean) => Promise<void> }>
  stopPtys: () => Promise<void>
  deleteHistory: () => Promise<void>
  preserveBranchHead: (
    result: RemoveWorktreeResult | undefined,
    fallbackHead: string | undefined
  ) => RemoveWorktreeResult
  finishRemoval: (result: RemoveWorktreeResult) => void
}): Promise<RemoveWorktreeResult & { warning?: string }> {
  const { repo, target, registeredWorktree, provider, connectionId } = args
  const canonicalPath = registeredWorktree.path
  const hooks = await getArchiveHooksForRemoval(repo, connectionId)
  const archiveScript = hooks?.scripts.archive
  let warning: string | undefined
  let archiveHookOverride: ArchiveHookOverride | undefined

  if (archiveScript && args.runHooks) {
    const result = await runRemoteArchiveHook(repo, connectionId, canonicalPath, archiveScript)
    archiveHookOverride = gateWorktreeRemovalOnArchiveHook({
      worktreePath: canonicalPath,
      result,
      allowFailure: args.allowFailedArchiveHook
    })
  } else if (archiveScript) {
    warning = `orca.yaml archive hook skipped for ${canonicalPath}; pass --run-hooks to run it.`
    console.warn(`[hooks] ${warning}`)
  }

  const refreshedWorktrees = await provider.listWorktrees(repo.path)
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

  const removeOptions = !args.deleteBranch ? { deleteBranch: args.deleteBranch } : {}
  const gate = await args.acquireWatcherRemoval(refreshed.path, connectionId)
  let rawResult: RemoveWorktreeResult | undefined
  let completed = false
  try {
    await args.stopPtys()
    rawResult = await (Object.keys(removeOptions).length > 0
      ? provider.removeWorktree(refreshed.path, args.force, removeOptions)
      : provider.removeWorktree(refreshed.path, args.force))
    completed = true
  } finally {
    await gate.finish(completed)
  }
  const result = args.preserveBranchHead(rawResult, refreshed.head)
  await cleanupUnusedWorktreePushTargetRemoteSsh(
    provider,
    repo.path,
    target.id,
    args.removedPushTarget,
    args.store
  )
  await args.deleteHistory()
  args.finishRemoval(result)
  return {
    ...result,
    ...(archiveHookOverride ? { archiveHookOverride } : {}),
    ...(warning ? { warning } : {})
  }
}
