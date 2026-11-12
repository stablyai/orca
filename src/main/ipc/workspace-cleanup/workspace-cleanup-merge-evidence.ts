import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'
import { resolveDefaultBaseRefViaExec } from '../../../shared/git/refs/git-default-base-ref'
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
    // A reused branch records itself (or its remote copy) as base, which would make every commit look landed.
    if (!ref || isFullGitCommitOid(ref) || namesBranch(ref, branchName)) {
      continue
    }
    const oid = await resolveCommitOid(git, ref)
    if (oid) {
      return oid
    }
  }
  const defaultRef = await resolveDefaultBaseRefViaExec(git)
  return defaultRef ? resolveCommitOid(git, defaultRef) : null
}

function namesBranch(ref: string, branchName: string): boolean {
  if (!branchName) {
    return false
  }
  const shortRef = ref.replace(/^refs\/(heads|remotes)\//, '')
  return shortRef === branchName || shortRef.endsWith(`/${branchName}`)
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
