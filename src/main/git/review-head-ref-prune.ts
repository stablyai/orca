import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  isValidReviewHeadNumber,
  selectReviewHeadLocalRefsToPrune
} from '../../shared/review-head-tracking-ref'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { gitExecFileAsync } from './runner'
import type { GitExecOptions } from './command-runner/git-exec-options'

type GitExec = (args: string[]) => Promise<{ stdout: string; stderr: string }>

/**
 * Whether any *other* worktree in the same repo still links the same PR/MR.
 * Call before dropping metadata for the deleted worktree.
 */
export function otherWorktreesStillLinkReview(
  worktreeMetaById: Record<string, WorktreeMeta | undefined>,
  params: {
    excludeWorktreeId: string
    repoId: string
    githubPrNumber?: number | null
    gitlabMrIid?: number | null
  }
): boolean {
  const wantPr = isValidReviewHeadNumber(params.githubPrNumber) ? params.githubPrNumber : null
  const wantMr = isValidReviewHeadNumber(params.gitlabMrIid) ? params.gitlabMrIid : null
  if (wantPr === null && wantMr === null) {
    return false
  }

  for (const [worktreeId, meta] of Object.entries(worktreeMetaById)) {
    if (!meta || worktreeId === params.excludeWorktreeId) {
      continue
    }
    if (getRepoIdFromWorktreeId(worktreeId) !== params.repoId) {
      continue
    }
    if (wantPr !== null && meta.linkedPR === wantPr) {
      return true
    }
    if (wantMr !== null && meta.linkedGitLabMR === wantMr) {
      return true
    }
  }
  return false
}

export async function listOrcaReviewHeadLocalRefs(gitExec: GitExec): Promise<string[]> {
  try {
    const { stdout } = await gitExec(['for-each-ref', '--format=%(refname)', 'refs/orca/'])
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch (error) {
    // Why: empty namespace succeeds with empty stdout; real for-each-ref failures must still warn.
    console.warn('[git] Failed to list durable review-head refs:', error)
    return []
  }
}

export async function deleteReviewHeadLocalRefs(
  gitExec: GitExec,
  refNames: readonly string[]
): Promise<string[]> {
  const deleted: string[] = []
  for (const refName of refNames) {
    try {
      // Why: update-ref -d is the standard way to drop a local ref without
      // touching the worktree checkout (already removed at this point).
      await gitExec(['update-ref', '-d', refName])
      deleted.push(refName)
    } catch (error) {
      console.warn(`[git] Failed to prune durable review-head ref ${refName}:`, error)
    }
  }
  return deleted
}

/**
 * After a successful worktree delete, drop durable refs/orca/** pins for that
 * PR/MR when no sibling worktree still links them (#10431).
 */
export async function pruneReviewHeadLocalRefsAfterWorktreeDelete(params: {
  repoPath: string
  repoId: string
  deletedWorktreeId: string
  meta: Pick<WorktreeMeta, 'linkedPR' | 'linkedGitLabMR'> | null | undefined
  worktreeMetaById: Record<string, WorktreeMeta | undefined>
  gitExec?: GitExec
  localGitOptions?: GitExecOptions
}): Promise<string[]> {
  const githubPrNumber = params.meta?.linkedPR ?? null
  const gitlabMrIid = params.meta?.linkedGitLabMR ?? null
  if (!isValidReviewHeadNumber(githubPrNumber) && !isValidReviewHeadNumber(gitlabMrIid)) {
    return []
  }

  if (
    otherWorktreesStillLinkReview(params.worktreeMetaById, {
      excludeWorktreeId: params.deletedWorktreeId,
      repoId: params.repoId,
      githubPrNumber,
      gitlabMrIid
    })
  ) {
    return []
  }

  const gitExec: GitExec =
    params.gitExec ??
    ((args) =>
      gitExecFileAsync(args, {
        cwd: params.repoPath,
        ...params.localGitOptions
      }))

  const refs = await listOrcaReviewHeadLocalRefs(gitExec)
  const toDelete = selectReviewHeadLocalRefsToPrune(refs, {
    githubPrNumber,
    gitlabMrIid
  })
  if (toDelete.length === 0) {
    return []
  }
  return deleteReviewHeadLocalRefs(gitExec, toDelete)
}
