import { WorktreeCreateCollisionError } from '../../../../shared/new-workspace/worktree-create-collision'
import { getBranchConflictKind } from '../../../git/repo-branch-conflict'
import { getSelectedReviewBranch } from '../../integrations/reviews/selected-review-branch'
import type { RemoteTrackingBase } from '../../repositories/runtime-remote-fetch-controller'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import {
  canCheckoutExistingLocalBranch,
  resolveCreateBranchName
} from './runtime-worktree-create-git'

/** open-existing-v2 pins the selected branch, or refuses before any candidate is tried. */
export async function resolveExplicitReuseBranch(args: {
  request: RuntimeManagedWorktreeCreateArgs
  repo: { path: string }
  sanitizedName: string
  settings: { branchPrefix: string; branchPrefixCustom?: string }
  username: string
  baseBranch: string
  remoteTrackingBase?: RemoteTrackingBase | null
  localWorktreeGitOptions: { wslDistro?: string }
}): Promise<{ branchName: string; checkoutExistingBranch: boolean } | null> {
  if (args.request.branchIntent !== 'open-existing-v2') {
    return null
  }
  if (
    !args.request.branchNameOverride ||
    args.request.pushTarget ||
    getSelectedReviewBranch(args.request)
  ) {
    throw new Error(
      'Reuse branch requires an explicit branch selection without a review push target.'
    )
  }
  const branchName = await resolveCreateBranchName(
    args.repo.path,
    args.request.branchNameOverride,
    args.sanitizedName,
    args.settings,
    args.username,
    args.localWorktreeGitOptions
  )
  const checkoutExistingBranch = await canCheckoutExistingLocalBranch(
    args.repo.path,
    branchName,
    args.baseBranch,
    args.localWorktreeGitOptions,
    true
  )
  if (!checkoutExistingBranch) {
    if (args.remoteTrackingBase?.branch !== branchName) {
      throw new Error(
        `Branch "${branchName}" was not found locally. Select its remote branch again, or turn off Reuse branch.`
      )
    }
    const conflict = await getBranchConflictKind(
      args.repo.path,
      branchName,
      args.remoteTrackingBase.ref,
      args.localWorktreeGitOptions
    )
    if (conflict) {
      throw new WorktreeCreateCollisionError(
        `Cannot reuse branch "${branchName}" because its name conflicts with an existing branch. Choose a different branch or turn off Reuse branch.`
      )
    }
  }
  return { branchName, checkoutExistingBranch }
}
