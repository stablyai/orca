import type { Repo } from '../../../shared/repository/repo-types'
import { isFolderRepo } from '../../../shared/repository/repo-kind'
import { normalizeRuntimePathForComparison } from '../../../shared/file-access/cross-platform-path'
import type { GitRepoRegistrationInfo } from '../../git/repositories/discovery/repo-detection'
import { listWorktreeGraph } from '../../git/worktrees/catalog/worktree-scan-cache'

/** Matches projects registered for any non-bare checkout in the added checkout's worktree graph. */
export async function readCheckoutFamilyMatch(
  gitInfo: Pick<GitRepoRegistrationInfo, 'isRepo' | 'rootPath' | 'mainRepoPath'> | null
): Promise<(repo: Repo) => boolean> {
  if (!gitInfo?.isRepo) {
    return matchCheckoutFamily(gitInfo)
  }
  // Git failures list nothing, which keeps the main-checkout match.
  const worktrees = await listWorktreeGraph(gitInfo.rootPath)
  return matchCheckoutFamily(
    gitInfo,
    worktrees.filter((worktree) => !worktree.isBare).map((worktree) => worktree.path)
  )
}

/**
 * Linked worktrees report their own toplevel; match a project already registered for any checkout
 * of the same worktree graph (main or sibling) to avoid duplicate projects for one repository.
 * Writers must apply this match synchronously right before inserting, so concurrent adds of two
 * siblings cannot both pass it.
 */
export function matchCheckoutFamily(
  gitInfo: Pick<GitRepoRegistrationInfo, 'mainRepoPath'> | null,
  familyPaths: readonly string[] = []
): (repo: Repo) => boolean {
  const familyKeys = new Set(familyPaths.map(normalizeRuntimePathForComparison))
  if (gitInfo?.mainRepoPath) {
    familyKeys.add(normalizeRuntimePathForComparison(gitInfo.mainRepoPath))
  }
  if (familyKeys.size === 0) {
    return () => false
  }
  // Only Git checkouts share project identity with their worktrees; folder records do not deduplicate them.
  return (repo) =>
    !isFolderRepo(repo) && familyKeys.has(normalizeRuntimePathForComparison(repo.path))
}
