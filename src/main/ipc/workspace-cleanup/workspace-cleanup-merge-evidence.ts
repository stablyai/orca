import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'
import { resolveDefaultBaseRefViaExec } from '../../../shared/git/refs/git-default-base-ref'
import { localBranchHasNoUnmergedChanges } from '../../git/refs/resolution/local-branch-merge-proof'
import type { PRInfo } from '../../../shared/github/pull-request-types'
import type { Repo } from '../../../shared/repo-types'
import {
  readWorkspaceReviewPR,
  type PRCacheView
} from '../../../shared/sidebar-list/workspace-review-facts'
import { isFullGitObjectId } from '../../git/refs/resolution/commit-object-ref'
import { resolveWorktreeAddBaseRef, worktreeBaseRefFamily } from '../../../shared/worktree/base-ref'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorkspaceCleanupMergeEvidence } from '../../../shared/workspace-cleanup/workspace-cleanup'
import {
  WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
  WorkspaceCleanupScanCancelledError,
  withWorkspaceCleanupTimeout
} from './workspace-cleanup-scan-primitives'

type CleanupGit = (argv: string[]) => Promise<{ stdout: string }>

/** Offline: local refs and the cached PR only, so a stale cache can miss a merge but never invent one. */
export async function readWorkspaceCleanupMergeEvidence(
  worktree: Worktree,
  repo: Repo,
  prCache: PRCacheView<PRInfo>,
  signal?: AbortSignal
): Promise<WorkspaceCleanupMergeEvidence | undefined> {
  try {
    return await withWorkspaceCleanupTimeout(
      (signal) => readMergeEvidence(worktree, repo, prCache, signal),
      WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
      'Timed out reading merge evidence.',
      signal
    )
  } catch (error) {
    if (error instanceof WorkspaceCleanupScanCancelledError) {
      throw error
    }
    return undefined
  }
}

async function readMergeEvidence(
  worktree: Worktree,
  repo: Repo,
  prCache: PRCacheView<PRInfo>,
  signal: AbortSignal
): Promise<WorkspaceCleanupMergeEvidence | undefined> {
  const git: CleanupGit = (argv) => gitExecFileAsync(argv, { cwd: worktree.path, signal })
  const baseOid = await resolveWorkspaceCleanupBaseOid(worktree, repo, git)
  // Read HEAD now: the listing's head can predate an agent's newest commit.
  const headOid = await resolveCommitOid(git, 'HEAD')
  if (!baseOid || !headOid) {
    return undefined
  }
  const aheadOfDefault = Number.parseInt(
    (await git(['rev-list', '--count', `${baseOid}..${headOid}`])).stdout.trim(),
    10
  )
  if (!Number.isFinite(aheadOfDefault)) {
    return undefined
  }
  const branchName = worktree.branch.replace(/^refs\/heads\//, '')
  // The proof reads the branch ref, so it only speaks for HEAD while HEAD is still that branch.
  // Prove against the base alone: the default target list includes the worktree's HEAD, the branch itself.
  const headInDefaultBranch =
    aheadOfDefault === 0 ||
    (branchName.length > 0 &&
      (await resolveCommitOid(git, `refs/heads/${branchName}`)) === headOid &&
      (await localBranchHasNoUnmergedChanges({
        cwd: worktree.path,
        branchName,
        targetRefs: [baseOid],
        refreshRemoteTargets: false,
        options: { signal }
      })))
  const review = readWorkspaceReviewPR(worktree, repo, prCache)
  const head = headOid.toLowerCase()
  return {
    headInDefaultBranch,
    aheadOfDefault,
    ...(review?.state === 'merged'
      ? {
          mergedReview: {
            number: review.number,
            provider: 'github' as const,
            containsHead: [review.headSha, review.confirmedContainedHeadOid].some(
              (oid) => oid?.trim().toLowerCase() === head
            )
          }
        }
      : {})
  }
}

/** First resolvable of worktree base, project base, repo default; a pinned OID is not a branch the work could land in. */
async function resolveWorkspaceCleanupBaseOid(
  worktree: Worktree,
  repo: Repo,
  git: CleanupGit
): Promise<string | null> {
  const branchName = worktree.branch.replace(/^refs\/heads\//, '')
  for (const candidate of [worktree.baseRef, repo.worktreeBaseRef]) {
    const ref = candidate?.trim()
    if (!ref || isFullGitObjectId(ref)) {
      continue
    }
    const oid = await resolveBranchBaseOid(git, ref, branchName)
    if (oid) {
      return oid
    }
  }
  const defaultRef = await resolveDefaultBaseRefViaExec(git)
  return defaultRef ? resolveBranchBaseOid(git, defaultRef, branchName) : null
}

/** Qualified so a tag cannot shadow the branch; a reused branch records itself (or its remote copy) as base, which would make every commit look landed. */
async function resolveBranchBaseOid(
  git: CleanupGit,
  ref: string,
  branchName: string
): Promise<string | null> {
  const qualified = await resolveWorktreeAddBaseRef(
    ref,
    async (candidate) => (await resolveCommitOid(git, candidate)) !== null
  )
  const family = worktreeBaseRefFamily(qualified)
  // Only a branch can hold landed work; a tag or a name that resolves to nothing is not a base.
  if (family === null || family === branchName) {
    return null
  }
  return resolveCommitOid(git, qualified)
}

async function resolveCommitOid(git: CleanupGit, ref: string): Promise<string | null> {
  if (ref.startsWith('-')) {
    return null
  }
  try {
    return (
      (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).stdout.trim() || null
    )
  } catch {
    return null
  }
}
