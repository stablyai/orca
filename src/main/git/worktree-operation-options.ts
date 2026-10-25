import type {
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion
} from '../../shared/worktree/base-ref-drift-types'
import { readGitCommandFailureText } from '../../shared/git-command-failure-text'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { GitAdmissionTier } from '../../shared/rpc-contract/git-admission-tier-params'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { WorktreeCheckoutProgressListener } from './worktree-checkout-progress'

export type AddWorktreeResult = {
  localBaseRefRefresh?: LocalBaseRefRefreshResult
  localBaseRefUpdateSuggestion?: LocalBaseRefUpdateSuggestion
}

export type SparseWorktreeCreateError = Error & {
  cleanupFailed?: boolean
}

export type GitWorktreeExecOptions = {
  wslDistro?: string
  signal?: AbortSignal
  timeout?: number
  includeCreatePreparations?: boolean
  admissionTier?: GitAdmissionTier
  spawnOnWorkerThread?: boolean
}

export type WorktreeRemovalPreflightOptions = GitWorktreeExecOptions & {
  ignoredUntrackedPaths?: readonly string[]
}

export type AddWorktreeOptions = GitWorktreeExecOptions & {
  checkoutExistingBranch?: boolean
  /** Progress of the checkout `git worktree add` performs; never called for `--no-checkout`. */
  onCheckoutProgress?: WorktreeCheckoutProgressListener
  suggestLocalBaseRefUpdate?: boolean
  remoteTrackingBase?: {
    base: string
    branch: string
    ref: string
  }
}

export type RemoveWorktreeOptions = GitWorktreeExecOptions & {
  deleteBranch?: boolean
  forceBranchDelete?: boolean
  knownRemovedWorktree?: Pick<GitWorktreeInfo, 'branch' | 'head' | 'locked' | 'lockReason'>
  /** Stops only `git worktree remove`; a killed branch cleanup could strand a ref lock. */
  checkoutDeleteSignal?: AbortSignal
}

// Bound stalled checkouts; this default also sets the floor for ORCA_WORKTREE_ADD_TIMEOUT_MS.
export const WORKTREE_ADD_TIMEOUT_MS = 180_000
// Allow slow content filters while bounding overrides to 30 minutes.
export const WORKTREE_ADD_TIMEOUT_MAX_MS = 30 * 60_000
export const WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS = 30_000
export const WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS = 30_000
// A wedged shared scan would otherwise stall every later listing.
export const WORKTREE_LIST_TIMEOUT_MS = 30_000

/** Clamp ORCA_WORKTREE_ADD_TIMEOUT_MS; warn for nonblank rejected/clamped values, not fractional truncation. */
export function resolveWorktreeAddTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORCA_WORKTREE_ADD_TIMEOUT_MS?.trim()
  const requested = Math.floor(Number(raw))
  // Guard against values entered in seconds rather than milliseconds.
  const resolved = Number.isNaN(requested)
    ? WORKTREE_ADD_TIMEOUT_MS
    : Math.min(Math.max(requested, WORKTREE_ADD_TIMEOUT_MS), WORKTREE_ADD_TIMEOUT_MAX_MS)
  // NaN compares unequal, so malformed nonblank values also warn.
  if (raw && resolved !== requested) {
    const problem = Number.isNaN(requested)
      ? 'is not a number'
      : `is outside [${WORKTREE_ADD_TIMEOUT_MS}, ${WORKTREE_ADD_TIMEOUT_MAX_MS}]ms`
    console.warn(
      `[git/worktree] ORCA_WORKTREE_ADD_TIMEOUT_MS="${raw}" ${problem}; using ${resolved}ms`
    )
  }
  return resolved
}

export type GitExecOptionsForWorktree = {
  cwd: string
  wslDistro?: string
  signal?: AbortSignal
  timeout?: number
  admissionTier?: GitAdmissionTier
  spawnOnWorkerThread?: boolean
}

export function gitExecOptions(
  cwd: string,
  options: GitWorktreeExecOptions = {}
): GitExecOptionsForWorktree {
  return {
    cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {}),
    ...(options.spawnOnWorkerThread ? { spawnOnWorkerThread: true } : {})
  }
}

export function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

export function isNotGitRepositoryError(error: unknown): boolean {
  return /not a git repository/i.test(readGitCommandFailureText(error))
}

export function normalizeLocalBranchRef(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

export type { LocalBaseRefRefreshResult, LocalBaseRefUpdateSuggestion, RemoveWorktreeResult }
