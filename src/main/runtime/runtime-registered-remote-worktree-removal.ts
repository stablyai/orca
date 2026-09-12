import type { GitPushTarget, GitWorktreeInfo } from '../../shared/worktree/types'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { Repo } from '../../shared/repo-types'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import { cleanupUnusedWorktreePushTargetRemoteSsh } from '../ipc/worktree-remote'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeWorktreeRemovalTarget } from './runtime-worktree-selection'
import { gateRemovalWhereArchiveHookCannotRun } from '../worktree-archive-hook-gate'

export async function removeRuntimeRegisteredRemoteWorktree(args: {
  repo: Repo
  target: RuntimeWorktreeRemovalTarget
  registeredWorktree: GitWorktreeInfo
  removedPushTarget: GitPushTarget | undefined
  store: RuntimeStore
  provider: SshGitProvider
  /** From the resolved removal route; `repo.connectionId!` answered null for an `ssh:`-only row. */
  connectionId: string
  /** #19334: this path runs no archive hook, so the gate below decides what that means. */
  runHooks: boolean
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
  // Precondition, before anything is stopped or deleted: no archive hook runs here, so a removal
  // that asked for one refuses rather than deleting with the archive step silently skipped.
  const hookWarning = gateRemovalWhereArchiveHookCannotRun({
    repo,
    worktreePath: registeredWorktree.path,
    runHooks: args.runHooks
  })
  const removeOptions = !args.deleteBranch ? { deleteBranch: args.deleteBranch } : {}
  const gate = await args.acquireWatcherRemoval(registeredWorktree.path, connectionId)
  let rawResult: RemoveWorktreeResult | undefined
  let completed = false
  try {
    await args.stopPtys()
    rawResult = await (Object.keys(removeOptions).length > 0
      ? provider.removeWorktree(registeredWorktree.path, args.force, removeOptions)
      : provider.removeWorktree(registeredWorktree.path, args.force))
    completed = true
  } finally {
    await gate.finish(completed)
  }
  const result = args.preserveBranchHead(rawResult, registeredWorktree.head)
  await cleanupUnusedWorktreePushTargetRemoteSsh(
    provider,
    repo.path,
    target.id,
    args.removedPushTarget,
    args.store
  )
  await args.deleteHistory()
  args.finishRemoval(result)
  return hookWarning ? { ...result, warning: hookWarning } : result
}
