import type { Repo } from '../../../shared/repository/repo-types'
import { isFolderRepo } from '../../../shared/repository/repo-kind'
import { normalizeRuntimePathForComparison } from '../../../shared/file-access/cross-platform-path'
import type { GitRepoRegistrationInfo } from '../../git/repositories/discovery/repo-detection'

/** Linked worktrees report their own toplevel; match their main checkout's project to avoid duplicate host setups. */
export function matchLinkedWorktreeMainCheckout(
  gitInfo: Pick<GitRepoRegistrationInfo, 'mainRepoPath'> | null
): (repo: Repo) => boolean {
  if (!gitInfo?.mainRepoPath) {
    return () => false
  }
  const mainCheckoutKey = normalizeRuntimePathForComparison(gitInfo.mainRepoPath)
  // Only Git checkouts share project identity with their worktrees; folder records do not deduplicate them.
  return (repo) =>
    !isFolderRepo(repo) && normalizeRuntimePathForComparison(repo.path) === mainCheckoutKey
}
