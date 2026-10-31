import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import { getBranchConflictKind } from '../git/repo'
import { getSelectedReviewBranch } from './selected-review-branch'
import { resolveCreateBranchName } from './runtime-worktree-create-git'

export async function resolveLegacyRemoteBranch(args: {
  request: RuntimeManagedWorktreeCreateArgs
  repo: { path: string }
  sanitizedName: string
  settings: { branchPrefix: string; branchPrefixCustom?: string }
  username: string
  baseBranch: string
  localWorktreeGitOptions: { wslDistro?: string }
}): Promise<string | null> {
  if (
    args.request.branchIntent !== 'open-existing' ||
    !args.request.branchNameOverride ||
    args.request.pushTarget ||
    getSelectedReviewBranch(args.request) !== null
  ) {
    return null
  }
  const branch = await resolveCreateBranchName(
    args.repo.path,
    args.request.branchNameOverride,
    args.sanitizedName,
    args.settings,
    args.username,
    args.localWorktreeGitOptions
  )
  const conflict = await getBranchConflictKind(
    args.repo.path,
    branch,
    args.baseBranch,
    args.localWorktreeGitOptions
  )
  return conflict === null ? branch : null
}
