import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'
import { getDefaultBaseRefAsync } from '../../git/refs/resolution/repo-default-base-ref'
import { localBranchHasNoUnmergedChanges } from '../../git/refs/resolution/local-branch-merge-proof'
import type { PRInfo } from '../../../shared/github/pull-request-types'
import type { Repo } from '../../../shared/repo-types'
import {
  readWorkspaceReviewPR,
  type PRCacheView
} from '../../../shared/sidebar-list/workspace-review-facts'
import { isFullGitCommitOid } from '../../../shared/source-control/decisions/source-control-base-ref-resolution'
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
  if (!baseOid) {
    return undefined
  }
  const aheadOfDefault = Number.parseInt(
    (await git(['rev-list', '--count', `${baseOid}..HEAD`])).stdout.trim(),
    10
  )
  if (!Number.isFinite(aheadOfDefault)) {
    return undefined
  }
  const branchName = worktree.branch.replace(/^refs\/heads\//, '')
  // The worktree's HEAD is the branch itself, so prove against the base alone, never the default target list.
  const headInDefaultBranch =
    aheadOfDefault === 0 ||
    (branchName.length > 0 &&
      (await localBranchHasNoUnmergedChanges({
        cwd: worktree.path,
        branchName,
        targetRefs: [baseOid],
        refreshRemoteTargets: false,
        options: { signal }
      })))
  const review = readWorkspaceReviewPR(worktree, repo, prCache)
  const head = worktree.head.trim().toLowerCase()
  return {
    headInDefaultBranch,
    aheadOfDefault,
    ...(review?.state === 'merged'
      ? {
          mergedReview: {
            number: review.number,
            provider: 'github' as const,
            containsHead:
              head.length > 0 &&
              [review.headSha, review.confirmedContainedHeadOid].some(
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
  for (const candidate of [worktree.baseRef, repo.worktreeBaseRef]) {
    const ref = candidate?.trim()
    if (!ref || isFullGitCommitOid(ref)) {
      continue
    }
    const oid = await resolveCommitOid(git, ref)
    if (oid) {
      return oid
    }
  }
  const defaultRef = await getDefaultBaseRefAsync(worktree.path)
  return defaultRef ? resolveCommitOid(git, defaultRef) : null
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
