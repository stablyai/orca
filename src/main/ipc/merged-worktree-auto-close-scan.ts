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
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../shared/execution-host'
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
import { withWorkspaceCleanupTimeout } from './workspace-cleanup-scan-primitives'

/** Why bounded: the sweep runs behind a worktree list load and must never keep Git busy for it. */
export const MERGED_WORKTREE_AUTO_CLOSE_GIT_TIMEOUT_MS = 10_000

/** `signal` cancels the sweep when the list that triggered it is abandoned. */
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
  // Why the resolver and not `connectionId`: a runtime-owned repo carries
  // `executionHostId: 'runtime:…'` and no connection, so a connection-only test
  // reads it as local and lets the sweep probe a checkout this machine does not own.
  const repoContext: MergedWorktreeAutoCloseRepoContext = {
    isFolderRepo: isFolderRepo(repo),
    isRemoteRepo: getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID
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
    const worktreeContext = resolveMergedWorktreeAutoCloseWorktreeContext(
      repoContext,
      repo,
      worktree
    )
    const structuralSkip = getMergedWorktreeAutoCloseStructuralSkipReason(
      worktree,
      worktreeContext,
      now,
      graceMs
    )
    const evidence = structuralSkip
      ? UNREAD_MERGED_WORKTREE_AUTO_CLOSE_EVIDENCE
      : await readMergedWorktreeAutoCloseEvidence(repo, worktree, gitOptions, options.signal)
    decisions.push(decideMergedWorktreeAutoClose(worktree, worktreeContext, evidence, now, graceMs))
  }
  return decisions
}

/**
 * Narrow the repo's context to one workspace's own execution host.
 *
 * Why per workspace: worktree ids are `repoId::path` and repeat across hosts, so
 * a locally-owned repo can still list a workspace whose persisted `hostId` names
 * an SSH or runtime host. That workspace has no local merge proof, and a removal
 * fenced to this machine would not reach it anyway.
 */
function resolveMergedWorktreeAutoCloseWorktreeContext(
  repoContext: MergedWorktreeAutoCloseRepoContext,
  repo: Repo,
  worktree: Worktree
): MergedWorktreeAutoCloseRepoContext {
  if (repoContext.isRemoteRepo) {
    return repoContext
  }
  return {
    ...repoContext,
    isRemoteRepo: getWorktreeExecutionHostId(worktree, repo) !== LOCAL_EXECUTION_HOST_ID
  }
}

const UNREAD_MERGED_WORKTREE_AUTO_CLOSE_EVIDENCE: MergedWorktreeAutoCloseEvidence = {
  merged: null,
  clean: null,
  published: null
}

/**
 * Read what Git can prove about one workspace: published, merged, clean.
 *
 * Ordered cheapest-first and short-circuiting, because each probe costs one or
 * more `git` processes and any single "no" already keeps the workspace. A field
 * left null means unread, not false — the decision treats the two differently.
 */
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

/**
 * Whether the workspace has no uncommitted or untracked work. Null when the
 * status could not be read, so a failed probe never reads as "nothing to lose".
 * Shared link paths are excluded the same way the cleanup surfaces exclude them.
 */
async function readWorktreeCleanliness(
  repo: Repo,
  worktree: Worktree,
  signal: AbortSignal | undefined
): Promise<boolean | null> {
  const sharedLinkPaths = getWorktreeSharedLinkPaths(repo)
  try {
    // Why raced and not only aborted: `getStatus` accepts a signal but serves the
    // read through a shared in-flight lease, so a stall started by another reader
    // is not this signal's to cancel. Unbounded, that stall holds the repo's
    // in-flight sweep slot and blocks every later sweep for the repo.
    const status = await withWorkspaceCleanupTimeout(
      (timeoutSignal) =>
        getStatus(worktree.path, {
          signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
          ...(sharedLinkPaths.length > 0 ? { sharedLinkPaths } : {})
        }),
      MERGED_WORKTREE_AUTO_CLOSE_GIT_TIMEOUT_MS,
      'Timed out reading git status.'
    )
    return status.entries.length === 0
  } catch (error) {
    console.warn(
      `[worktree-auto-close] Failed to read status for workspace "${worktree.id}"`,
      error
    )
    return null
  }
}
