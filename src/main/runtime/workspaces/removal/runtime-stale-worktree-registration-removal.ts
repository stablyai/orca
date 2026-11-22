import type { Repo } from '../../../../shared/repository/repo-types'
import type { GitPushTarget, GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { RuntimePreservedBranchCleanup } from '../../repositories/runtime-preserved-branch-cleanup'
import type { WorktreeRemovalExpectation } from '../../../workspaces/removal/worktree-removal-expectation'
import { isStaleLocalWorktreeRegistration } from '../catalog/stale-worktree-registration-preflight'
import { removeStaleLocalWorktreeRegistration } from '../../../workspaces/removal/local-worktree-removal-recovery'
import { cleanupUnusedWorktreePushTargetRemote } from '../../../ipc/worktrees/worktree-remote'

export async function removeRuntimeStaleWorktreeRegistration({
  repo,
  registeredWorktree,
  removedMeta,
  removedPushTarget,
  worktreeId,
  force,
  deleteBranch,
  localWorktreeGitOptions,
  store,
  cleanupHostId,
  expectation,
  preservedBranchCleanup,
  purge,
  publish
}: {
  repo: Repo
  registeredWorktree: GitWorktreeInfo
  removedMeta: Parameters<typeof isStaleLocalWorktreeRegistration>[2]
  removedPushTarget: GitPushTarget | undefined
  worktreeId: string
  force: boolean
  deleteBranch: boolean
  localWorktreeGitOptions: LocalProjectWorktreeGitOptions
  store: RuntimeStore
  cleanupHostId?: ExecutionHostId
  expectation?: WorktreeRemovalExpectation
  preservedBranchCleanup: RuntimePreservedBranchCleanup
  purge: () => Promise<void>
  publish: () => void
}): Promise<RemoveWorktreeResult | undefined> {
  if (
    !(await isStaleLocalWorktreeRegistration(
      registeredWorktree,
      force,
      removedMeta,
      localWorktreeGitOptions
    ))
  ) {
    return undefined
  }
  if (expectation) {
    throw new Error('The reviewed Git workspace checkout changed before deletion.')
  }
  const result = await removeStaleLocalWorktreeRegistration({
    canonicalWorktreePath: registeredWorktree.path,
    repoPath: repo.path,
    localWorktreeGitOptions,
    registeredWorktree,
    deleteBranch
  })
  await cleanupUnusedWorktreePushTargetRemote(
    repo.path,
    worktreeId,
    removedPushTarget,
    store,
    localWorktreeGitOptions
  )
  preservedBranchCleanup.remember(
    worktreeId,
    cleanupHostId,
    result,
    registeredWorktree.head,
    removedPushTarget
  )
  await purge()
  publish()
  return result ?? {}
}
