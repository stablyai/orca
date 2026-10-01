import type { GitWorktreeInfo } from '../../shared/worktree/types'
import {
  isMembershipModelRows,
  listWorktreeGraph as listWorktreeGraphUnshared,
  listWorktreesFromMembershipStrict,
  listWorktreesStrictAllowingTrueEmpty as listWorktreesStrictAllowingTrueEmptyUnshared
} from './worktree-listing'
import { annotateSparseCheckoutStatus } from './worktree-sparse-annotation'
import { markWorktreeMembershipDirty } from './worktree-membership/worktree-membership-store'
import type { GitWorktreeExecOptions } from './worktree-operation-options'
import { WORKTREE_LIST_TIMEOUT_MS } from './worktree-operation-options'
import { resolveGitAdmissionTier } from './command-runner/git-operation-executor'

// Why: share concurrent `git worktree list` scans, which are expensive on Windows.
const inFlightWorktreeScans = new Map<string, Promise<GitWorktreeInfo[]>>()

type WorktreeScanKind = 'graph' | 'lenient' | 'strict' | 'strict-true-empty'

// Why: mutation generations prevent listings from joining stale scans.
const worktreeScanGenerations = new Map<string, number>()

function hasInFlightWorktreeScanForRepo(repoPath: string): boolean {
  const keyPrefix = `${repoPath}\0`
  for (const key of inFlightWorktreeScans.keys()) {
    if (key.startsWith(keyPrefix)) {
      return true
    }
  }
  return false
}

export function bumpWorktreeScanGeneration(repoPath: string): void {
  // Before the early return: the membership model must re-derive after every mutation, scan or not.
  markWorktreeMembershipDirty(repoPath)
  // Why: generations only prevent joining a pre-mutation scan; with no active scan, keeping the repo path just leaks completed mutation keys.
  if (!hasInFlightWorktreeScanForRepo(repoPath)) {
    return
  }
  worktreeScanGenerations.set(repoPath, (worktreeScanGenerations.get(repoPath) ?? 0) + 1)
}

function pruneWorktreeScanGeneration(repoPath: string): void {
  // Why: keep ordinary scan settlement O(1); only repos invalidated during an active scan need the cross-generation check.
  if (!worktreeScanGenerations.has(repoPath)) {
    return
  }
  if (!hasInFlightWorktreeScanForRepo(repoPath)) {
    worktreeScanGenerations.delete(repoPath)
  }
}

export function _getWorktreeScanCacheSizesForTests(): { inFlight: number; generations: number } {
  return {
    inFlight: inFlightWorktreeScans.size,
    generations: worktreeScanGenerations.size
  }
}

export function _resetWorktreeScanCacheForTests(): void {
  inFlightWorktreeScans.clear()
  worktreeScanGenerations.clear()
}

/**
 * Share one in-flight scan per (repo, distro, deadline, generation, kind). Coalescing keeps a
 * sidebar refresh from spawning a second `git worktree list` (expensive on Windows), but only
 * within one failure discipline: a strict joiner must never inherit a lenient scan's softened `[]`,
 * so the strict and lenient runners scan separately by design. The explicit kind is intentional:
 * function names can be rewritten by a production bundler and must not define cache identity.
 */
function shareWorktreeScan(
  repoPath: string,
  options: GitWorktreeExecOptions,
  kind: WorktreeScanKind,
  run: (repoPath: string, options: GitWorktreeExecOptions) => Promise<GitWorktreeInfo[]>
): Promise<GitWorktreeInfo[]> {
  if (options.signal) {
    return run(repoPath, options)
  }
  const generation = worktreeScanGenerations.get(repoPath) ?? 0
  const timeout = options.timeout ?? WORKTREE_LIST_TIMEOUT_MS
  // Why: callers with different deadlines cannot safely share which timeout wins the scan.
  // Why `kind`: a strict joiner must never receive a softened `[]` from a lenient scan.
  // Why the tier: an interactive listing joining a queued status scan inherits its wait.
  const key = `${repoPath}\0${options.wslDistro ?? ''}\0${timeout}\0${options.includeCreatePreparations === true}\0${generation}\0${kind}\0${resolveGitAdmissionTier(options.admissionTier)}`
  const inFlight = inFlightWorktreeScans.get(key)
  if (inFlight) {
    return inFlight
  }
  const scan = run(repoPath, options).finally(() => {
    if (inFlightWorktreeScans.get(key) === scan) {
      inFlightWorktreeScans.delete(key)
    }
    pruneWorktreeScanGeneration(repoPath)
  })
  inFlightWorktreeScans.set(key, scan)
  return scan
}

/**
 * Sparse annotation layered over the shared graph read rather than its own read, so a path-only
 * caller and a badge reader that overlap share one listing. Model rows already carry `isSparse`;
 * only rows Git answered directly pay the per-worktree probe. Strict stays separate because it must
 * be able to reject.
 */
async function runAnnotatedWorktreeScan(
  repoPath: string,
  options: GitWorktreeExecOptions
): Promise<GitWorktreeInfo[]> {
  const worktrees = await listWorktreeGraph(repoPath, options)
  return isMembershipModelRows(worktrees)
    ? worktrees
    : annotateSparseCheckoutStatus(repoPath, worktrees, options)
}

/**
 * List all worktrees for a git repo at the given path, from the repo's membership model. Concurrent
 * calls for the same repo share one read (unless the caller passes an AbortSignal, which must only
 * cancel its own read). Failures soften to `[]`.
 */
export function listWorktrees(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  return shareWorktreeScan(repoPath, options, 'lenient', runAnnotatedWorktreeScan)
}

/**
 * The worktree graph for callers that read only paths: Git-answered rows skip the sparse probes.
 * Concurrent callers share one generation-fenced read; an AbortSignal caller keeps its own.
 */
export function listWorktreeGraph(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  return shareWorktreeScan(repoPath, options, 'graph', listWorktreeGraphUnshared)
}

/**
 * Strict membership rows through the same in-flight map, so callers that must see a failure
 * (worktree-create verification) still coalesce with a concurrent refresh (#16520).
 */
export function listWorktreesSharedStrict(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  return shareWorktreeScan(repoPath, options, 'strict', listWorktreesFromMembershipStrict)
}

/**
 * The detected scan's discipline: reject a Git/host failure so it cannot publish as an
 * authoritative empty listing, but still answer `[]` for a repo that is gone or not a repo.
 * Its own kind because neither a strict nor a lenient joiner may inherit that middle contract.
 */
export function listWorktreesSharedStrictAllowingTrueEmpty(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  return shareWorktreeScan(
    repoPath,
    options,
    'strict-true-empty',
    listWorktreesStrictAllowingTrueEmptyUnshared
  )
}
