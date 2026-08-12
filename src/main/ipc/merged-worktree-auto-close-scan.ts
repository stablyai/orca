import type { Store } from '../persistence'
import { listRepoWorktrees } from '../repo-worktrees'
import { getStatus } from '../git/status'
import { getWorktreeSharedLinkPaths } from '../git/worktree-shared-directories'
import {
  hasWorktreeBranchUpstreamConfigured,
  isWorktreeBranchMergedIntoBase
} from '../git/worktree-branch-merge-state'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo, Worktree } from '../../shared/types'
import {
  decideMergedWorktreeAutoClose,
  getMergedWorktreeAutoCloseStructuralSkipReason,
  normalizeAutoCloseBranchName,
  resolveMergedWorktreeAutoCloseGraceMs,
  type MergedWorktreeAutoCloseDecision,
  type MergedWorktreeAutoCloseEvidence,
  type MergedWorktreeAutoCloseRepoContext
} from '../../shared/merged-worktree-auto-close'
import { mergeWorktree } from './worktree-logic'

/** Why bounded: the sweep runs behind a worktree list load and must never keep Git busy for it. */
export const MERGED_WORKTREE_AUTO_CLOSE_GIT_TIMEOUT_MS = 10_000

export type MergedWorktreeAutoCloseScanOptions = {
  now?: number
  signal?: AbortSignal
}

/** The grace window this profile configured, in ms. */
function getMergedWorktreeAutoCloseGraceMs(store: Store): number {
  return resolveMergedWorktreeAutoCloseGraceMs(
    store.getSettings().autoCloseMergedWorktreesGraceMinutes
  )
}

/**
 * Decide, for one repo, which workspaces have landed and can be closed. Every
 * workspace the repo owns gets a decision so callers can report why a
 * workspace stayed.
 */
export async function scanMergedWorktreeAutoCloseCandidates(
  store: Store,
  repo: Repo,
  options: MergedWorktreeAutoCloseScanOptions = {}
): Promise<MergedWorktreeAutoCloseDecision[]> {
  const now = options.now ?? Date.now()
  const graceMs = getMergedWorktreeAutoCloseGraceMs(store)
  const repoContext: MergedWorktreeAutoCloseRepoContext = {
    isFolderRepo: isFolderRepo(repo),
    isRemoteRepo: Boolean(repo.connectionId)
  }
  if (repoContext.isFolderRepo || repoContext.isRemoteRepo) {
    return []
  }

  const gitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  let worktrees: Worktree[]
  try {
    const gitWorktrees = await listRepoWorktrees(repo, {
      ...gitOptions,
      ...(options.signal ? { signal: options.signal } : {})
    })
    worktrees = gitWorktrees.map((gitWorktree) =>
      mergeWorktree(
        repo.id,
        gitWorktree,
        store.getWorktreeMeta(`${repo.id}::${gitWorktree.path}`),
        repo.displayName
      )
    )
  } catch (error) {
    console.warn(`[worktree-auto-close] Failed to list worktrees for repo "${repo.id}"`, error)
    return []
  }

  const decisions: MergedWorktreeAutoCloseDecision[] = []
  for (const worktree of worktrees) {
    const structuralSkip = getMergedWorktreeAutoCloseStructuralSkipReason(
      worktree,
      repoContext,
      now,
      graceMs
    )
    const evidence = structuralSkip
      ? UNREAD_MERGED_WORKTREE_AUTO_CLOSE_EVIDENCE
      : await readMergedWorktreeAutoCloseEvidence(repo, worktree, gitOptions, options.signal)
    decisions.push(decideMergedWorktreeAutoClose(worktree, repoContext, evidence, now, graceMs))
  }
  return decisions
}

const UNREAD_MERGED_WORKTREE_AUTO_CLOSE_EVIDENCE: MergedWorktreeAutoCloseEvidence = {
  merged: null,
  clean: null,
  published: null
}

async function readMergedWorktreeAutoCloseEvidence(
  repo: Repo,
  worktree: Worktree,
  gitOptions: { wslDistro?: string },
  signal: AbortSignal | undefined
): Promise<MergedWorktreeAutoCloseEvidence> {
  const branchName = normalizeAutoCloseBranchName(worktree.branch)
  const branchOptions = {
    ...gitOptions,
    ...(signal ? { signal } : {}),
    timeout: MERGED_WORKTREE_AUTO_CLOSE_GIT_TIMEOUT_MS
  }
  const published = await hasWorktreeBranchUpstreamConfigured(repo.path, branchName, branchOptions)
  if (published !== true) {
    // Why: the merge probe can shell out several times per branch; an
    // unpublished branch is already excluded, so do not pay for it.
    return { merged: null, clean: null, published }
  }
  const merged = await isWorktreeBranchMergedIntoBase(repo.path, branchName, branchOptions)
  if (merged !== true) {
    return { merged, clean: null, published }
  }
  return { merged, clean: await readWorktreeCleanliness(repo, worktree, signal), published }
}

async function readWorktreeCleanliness(
  repo: Repo,
  worktree: Worktree,
  signal: AbortSignal | undefined
): Promise<boolean | null> {
  const sharedLinkPaths = getWorktreeSharedLinkPaths(repo)
  try {
    const status = await getStatus(worktree.path, {
      ...(signal ? { signal } : {}),
      ...(sharedLinkPaths.length > 0 ? { sharedLinkPaths } : {})
    })
    return status.entries.length === 0
  } catch (error) {
    console.warn(
      `[worktree-auto-close] Failed to read status for workspace "${worktree.id}"`,
      error
    )
    return null
  }
}
