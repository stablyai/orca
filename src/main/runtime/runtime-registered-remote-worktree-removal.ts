import type { GitPushTarget, GitWorktreeInfo } from '../../shared/worktree/types'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { Repo } from '../../shared/repo-types'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import { cleanupUnusedWorktreePushTargetRemoteSsh } from '../ipc/worktree-remote'
import {
  getArchiveHooksForRemoval,
  runRemoteArchiveHook
} from '../ipc/worktrees/removal/worktree-archive-hook'
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
  force: boolean
  runHooks: boolean
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
  let warning: string | undefined
  if (hooks?.scripts.archive && args.runHooks) {
    const hookResult = await runRemoteArchiveHook(
      repo,
      connectionId,
      canonicalPath,
      hooks.scripts.archive
    )
    if (!hookResult.success) {
      console.error(`[hooks] archive hook failed for ${canonicalPath}:`, hookResult.output)
    }
  } else if (hooks?.scripts.archive) {
    warning = `orca.yaml archive hook skipped for ${canonicalPath}; pass --run-hooks to run it.`
    console.warn(`[hooks] ${warning}`)
  }
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
  return { ...result, ...(warning ? { warning } : {}) }
}
