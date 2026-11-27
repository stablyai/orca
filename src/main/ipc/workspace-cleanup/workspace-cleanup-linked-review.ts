import type { PRInfo } from '../../../shared/github/pull-requests/pull-request-types'
import type { Repo } from '../../../shared/repository/repo-types'
import {
  readWorkspaceReviewPR,
  type PRCacheView
} from '../../../shared/sidebar-list/feed-facts/workspace-review-facts'
import { getWorktreeGitHubPRUrl } from '../../../shared/worktree/github-linked-item-url'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorkspaceCleanupMergeEvidence } from '../../../shared/workspace-cleanup/workspace-cleanup'
import type { ProjectRuntimeResolutionStore } from '../../workspaces/execution-host/local-project-runtime-resolution'
import { getLocalProjectGhExecOptions } from '../../workspaces/execution-host/project-runtime-git-options'
import {
  WorkspaceCleanupScanCancelledError,
  withWorkspaceCleanupTimeout
} from './workspace-cleanup-scan-primitives'

const LINKED_PR_READ_TIMEOUT_MS = 10_000

export type WorkspaceCleanupReview = Pick<
  PRInfo,
  'number' | 'state' | 'headSha' | 'confirmedContainedHeadOid'
>

export type WorkspaceCleanupLinkedPRReader = (
  worktree: Pick<Worktree, 'branch' | 'linkedPR' | 'linkedWorkItem' | 'linkedItems' | 'head'>
) => Promise<WorkspaceCleanupReview | null>

/** Reads a local repo workspace's linked PR from GitHub by number, with the project's WSL and gh account. */
export function createWorkspaceCleanupLinkedPRReader(
  store: ProjectRuntimeResolutionStore,
  repo: Repo
): WorkspaceCleanupLinkedPRReader {
  return async (worktree) => {
    const { getPRForBranch } = await import('../../github/client/lookup/get-pr-for-branch')
    const linkedPRUrl = getWorktreeGitHubPRUrl(worktree, worktree.linkedPR)
    return getPRForBranch(repo.path, worktree.branch, worktree.linkedPR, null, null, {
      localGitExecOptions: {
        ...getLocalProjectGhExecOptions(store, repo),
        admissionTier: 'background'
      },
      ...(worktree.head ? { currentHeadOid: worktree.head } : {}),
      ...(linkedPRUrl ? { linkedPRUrl } : {})
    })
  }
}

/** The cached branch PR, else the linked PR read now: a cached miss or open PR can predate the merge at the same HEAD. */
export async function readWorkspaceCleanupReview(
  worktree: Pick<
    Worktree,
    'branch' | 'linkedPR' | 'suppressedGitHubPR' | 'linkedWorkItem' | 'linkedItems' | 'head'
  >,
  repo: Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'>,
  prCache: PRCacheView<PRInfo>,
  readLinkedPR: WorkspaceCleanupLinkedPRReader | undefined,
  signal?: AbortSignal
): Promise<WorkspaceCleanupReview | null> {
  const cached = readWorkspaceReviewPR(worktree, repo, prCache)
  const linkedPR = worktree.linkedPR
  if (cached?.state === 'merged' || typeof linkedPR !== 'number' || !readLinkedPR) {
    return cached
  }
  try {
    const pr = await withWorkspaceCleanupTimeout(
      () => readLinkedPR(worktree),
      LINKED_PR_READ_TIMEOUT_MS,
      'Timed out reading the linked PR.',
      signal
    )
    return pr?.number === linkedPR ? pr : cached
  } catch (error) {
    if (error instanceof WorkspaceCleanupScanCancelledError) {
      throw error
    }
    return cached
  }
}

/** A merged review counts as holding HEAD only when its head (or a provider-confirmed head) is HEAD. */
export function workspaceCleanupMergedReview(
  review: WorkspaceCleanupReview | null,
  headOid: string
): WorkspaceCleanupMergeEvidence['mergedReview'] {
  if (review?.state !== 'merged') {
    return undefined
  }
  const head = headOid.toLowerCase()
  return {
    number: review.number,
    provider: 'github',
    containsHead: [review.headSha, review.confirmedContainedHeadOid].some(
      (oid) => oid?.trim().toLowerCase() === head
    )
  }
}
