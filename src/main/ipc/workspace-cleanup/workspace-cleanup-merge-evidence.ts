import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'
import { offlineGitEnv } from '../../git/command-runner/git-environment/git-process-env'
import { resolveDefaultBaseRefViaExec } from '../../../shared/git/refs/git-default-base-ref'
import { localBranchHasNoUnmergedChanges } from '../../git/refs/resolution/local-branch-merge-proof'
import type { PRInfo } from '../../../shared/github/pull-requests/pull-request-types'
import type { Repo } from '../../../shared/repo-types'
import {
  readWorkspaceReviewPR,
  type PRCacheView
} from '../../../shared/sidebar-list/workspace-review-facts'
import { isFullGitObjectId } from '../../git/refs/resolution/commit-object-ref'
import {
  resolveWorktreeAddBaseRef,
  worktreeBaseRefFamily
} from '../../../shared/worktree/base-refs/base-ref'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorkspaceCleanupMergeEvidence } from '../../../shared/workspace-cleanup/workspace-cleanup'
import {
  WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
  WorkspaceCleanupScanCancelledError,
  withWorkspaceCleanupTimeout
} from './workspace-cleanup-scan-primitives'

type CleanupGit = (argv: string[]) => Promise<{ stdout: string }>

/** One scan's branch lookups for a repo: `refs/heads` and `refs/remotes` are shared by all of its worktrees. */
export type WorkspaceCleanupRepoRefs = {
  defaultBaseRef: () => Promise<string | null>
  commitOid: (qualifiedRef: string) => Promise<string | null>
}

function cleanupGit(cwd: string, signal: AbortSignal | undefined): CleanupGit {
  const env = offlineGitEnv()
  return (argv) => gitExecFileAsync(argv, { cwd, env, ...(signal ? { signal } : {}) })
}

/** Runs under the scan's signal, not a row's deadline, so one slow row cannot leave a cancelled answer for the rest. */
export function createWorkspaceCleanupRepoRefs(
  repo: Repo,
  signal?: AbortSignal
): WorkspaceCleanupRepoRefs {
  const git = cleanupGit(repo.path, signal)
  let defaultBaseRef: Promise<string | null> | undefined
  const commitOids = new Map<string, Promise<string | null>>()
  return {
    defaultBaseRef: () => (defaultBaseRef ??= resolveDefaultBaseRefViaExec(git)),
    commitOid: (qualifiedRef) => {
      let oid = commitOids.get(qualifiedRef)
      if (!oid) {
        oid = resolveCommitOid(git, qualifiedRef)
        commitOids.set(qualifiedRef, oid)
      }
      return oid
    }
  }
}

/** Offline: local refs and the cached PR only, so a stale cache can miss a merge but never invent one. */
export async function readWorkspaceCleanupMergeEvidence(
  worktree: Worktree,
  repo: Repo,
  prCache: PRCacheView<PRInfo>,
  repoRefs: WorkspaceCleanupRepoRefs,
  signal?: AbortSignal,
  coordinatorBranch?: string | null
): Promise<WorkspaceCleanupMergeEvidence | undefined> {
  try {
    return await withWorkspaceCleanupTimeout(
      (signal) => readMergeEvidence(worktree, repoRefs, repo, prCache, signal, coordinatorBranch),
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
  repoRefs: WorkspaceCleanupRepoRefs,
  repo: Repo,
  prCache: PRCacheView<PRInfo>,
  signal: AbortSignal,
  coordinatorBranch: string | null | undefined
): Promise<WorkspaceCleanupMergeEvidence | undefined> {
  const git = cleanupGit(worktree.path, signal)
  const baseOid = await resolveWorkspaceCleanupBaseOid(worktree, repo, repoRefs)
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
  // Prove against the target alone: the default target list includes the worktree's HEAD, the branch itself.
  let branchAtHead: Promise<boolean> | undefined
  const headLandedIn = async (targetOid: string): Promise<boolean> =>
    branchName.length > 0 &&
    (await (branchAtHead ??= resolveCommitOid(git, `refs/heads/${branchName}`).then(
      (oid) => oid === headOid
    ))) &&
    localBranchHasNoUnmergedChanges({
      cwd: worktree.path,
      branchName,
      targetRefs: [targetOid],
      refreshRemoteTargets: false,
      options: { signal }
    })
  const headInDefaultBranch = aheadOfDefault === 0 || (await headLandedIn(baseOid))
  const review = readWorkspaceReviewPR(worktree, repo, prCache)
  const head = headOid.toLowerCase()
  const mergedReview =
    review?.state === 'merged'
      ? {
          number: review.number,
          provider: 'github' as const,
          containsHead: [review.headSha, review.confirmedContainedHeadOid].some(
            (oid) => oid?.trim().toLowerCase() === head
          )
        }
      : undefined
  // Only worth proving when HEAD has not already landed another way.
  const coordinatorOid =
    coordinatorBranch && !headInDefaultBranch && mergedReview?.containsHead !== true
      ? await repoRefs.commitOid(`refs/heads/${coordinatorBranch}`)
      : null
  const headInCoordinatorBranch =
    coordinatorOid === null
      ? undefined
      : (await git(['rev-list', '--count', `${coordinatorOid}..${headOid}`])).stdout.trim() ===
          '0' || (await headLandedIn(coordinatorOid))
  return {
    headInDefaultBranch,
    aheadOfDefault,
    ...(headInCoordinatorBranch !== undefined ? { headInCoordinatorBranch } : {}),
    ...(mergedReview ? { mergedReview } : {})
  }
}

/** First resolvable of worktree base, project base, repo default; a pinned OID is not a branch the work could land in. */
async function resolveWorkspaceCleanupBaseOid(
  worktree: Worktree,
  repo: Repo,
  repoRefs: WorkspaceCleanupRepoRefs
): Promise<string | null> {
  const branchName = worktree.branch.replace(/^refs\/heads\//, '')
  for (const candidate of [worktree.baseRef, repo.worktreeBaseRef]) {
    const ref = candidate?.trim()
    if (!ref || isFullGitObjectId(ref)) {
      continue
    }
    const oid = await resolveBranchBaseOid(repoRefs, ref, branchName)
    if (oid) {
      return oid
    }
  }
  const defaultRef = await repoRefs.defaultBaseRef()
  return defaultRef ? resolveBranchBaseOid(repoRefs, defaultRef, branchName) : null
}

/** Qualified so a tag cannot shadow the branch; a reused branch records itself (or its remote copy) as base, which would make every commit look landed. */
async function resolveBranchBaseOid(
  repoRefs: WorkspaceCleanupRepoRefs,
  ref: string,
  branchName: string
): Promise<string | null> {
  const qualified = await resolveWorktreeAddBaseRef(
    ref,
    async (candidate) => (await repoRefs.commitOid(candidate)) !== null
  )
  const family = worktreeBaseRefFamily(qualified)
  // Only a branch can hold landed work; a tag or a name that resolves to nothing is not a base.
  if (family === null || family === branchName) {
    return null
  }
  return repoRefs.commitOid(qualified)
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
