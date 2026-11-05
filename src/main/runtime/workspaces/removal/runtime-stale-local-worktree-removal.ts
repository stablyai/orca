import type { RuntimeStore } from '../../runtime-store-contract'
import type { GitPushTarget, GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeWorktreeRemovalTarget } from '../catalog/runtime-worktree-selection'
import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { isStaleLocalWorktreeRegistration } from '../catalog/stale-worktree-registration-preflight'
import { removeStaleLocalWorktreeRegistration } from '../../../workspaces/removal/local-worktree-removal-recovery'
import { cleanupUnusedWorktreePushTargetRemote } from '../../../ipc/worktree-remote'

export async function removeRuntimeStaleLocalWorktreeRegistration(args: {
  registeredWorktree: GitWorktreeInfo
  force: boolean
  removedMeta: Parameters<typeof isStaleLocalWorktreeRegistration>[2]
  localOptions: LocalProjectWorktreeGitOptions
  repo: Repo
  target: RuntimeWorktreeRemovalTarget
  deleteBranch: boolean
  removedPushTarget: GitPushTarget | undefined
  store: RuntimeStore
  finishRemoval: (result: RemoveWorktreeResult | undefined) => Promise<void>
}): Promise<RemoveWorktreeResult | null> {
  if (
    !(await isStaleLocalWorktreeRegistration(
      args.registeredWorktree,
      args.force,
      args.removedMeta,
      args.localOptions
    ))
  ) {
    return null
  }
  const result = await removeStaleLocalWorktreeRegistration({
    canonicalWorktreePath: args.registeredWorktree.path,
    repoPath: args.repo.path,
    localWorktreeGitOptions: args.localOptions,
    registeredWorktree: args.registeredWorktree,
    deleteBranch: args.deleteBranch
  })
  await cleanupUnusedWorktreePushTargetRemote(
    args.repo.path,
    args.target.id,
    args.removedPushTarget,
    args.store,
    args.localOptions
  )
  await args.finishRemoval(result)
  return result ?? {}
}
