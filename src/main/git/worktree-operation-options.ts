import type {
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion
} from '../../shared/worktree/base-ref-drift-types'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'

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
}

export type WorktreeRemovalPreflightOptions = GitWorktreeExecOptions & {
  ignoredUntrackedPaths?: readonly string[]
}

export type AddWorktreeOptions = GitWorktreeExecOptions & {
  checkoutExistingBranch?: boolean
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
}

// Why: bound `git worktree add` so a OneDrive cloud-placeholder stall fails fast (STA-1292); ample for an ordinary large checkout, but not one behind a slow content filter (#12696).
// Doubles as the floor for ORCA_WORKTREE_ADD_TIMEOUT_MS — lowering it to fail faster also lowers the minimum any override can request.
export const WORKTREE_ADD_TIMEOUT_MS = 180_000
// Why: ceiling for ORCA_WORKTREE_ADD_TIMEOUT_MS (#12696) — ~8x the slowest reported checkout (3.5 min). The cost is that a genuine stall now blocks a create for up to 30 min instead of 3.
export const WORKTREE_ADD_TIMEOUT_MAX_MS = 30 * 60_000
export const WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS = 30_000
export const WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS = 30_000
// Why: one wedged shared scan otherwise hangs every later list, including create's post-add re-list.
export const WORKTREE_LIST_TIMEOUT_MS = 30_000

/**
 * `ORCA_WORKTREE_ADD_TIMEOUT_MS` clamped into [{@link WORKTREE_ADD_TIMEOUT_MS},
 * {@link WORKTREE_ADD_TIMEOUT_MAX_MS}]; unset, blank, or unparseable yields the default.
 * Warns when a non-blank value is rejected or clamped; trimming and fractional truncation are silent.
 * `env` is injectable for tests.
 */
export function resolveWorktreeAddTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORCA_WORKTREE_ADD_TIMEOUT_MS?.trim()
  const requested = Math.floor(Number(raw))
  // Why: `=300` reads as seconds to most operators, so clamp rather than obey.
  const resolved = Number.isNaN(requested)
    ? WORKTREE_ADD_TIMEOUT_MS
    : Math.min(Math.max(requested, WORKTREE_ADD_TIMEOUT_MS), WORKTREE_ADD_TIMEOUT_MAX_MS)
  // Why: an `isNaN` guard here would delete the unparseable-value warning — comparing against NaN is unequal, and that is what catches it.
  if (raw && resolved !== requested) {
    const problem = Number.isNaN(requested)
      ? // Why: `600_000` copied out of this file is NaN, not out of range — say which.
        'is not a number'
      : `is outside [${WORKTREE_ADD_TIMEOUT_MS}, ${WORKTREE_ADD_TIMEOUT_MAX_MS}]ms`
    console.warn(
      `[git/worktree] ORCA_WORKTREE_ADD_TIMEOUT_MS="${raw}" ${problem}; using ${resolved}ms`
    )
  }
  return resolved
}

export function gitExecOptions(
  cwd: string,
  options: GitWorktreeExecOptions = {}
): { cwd: string; wslDistro?: string; signal?: AbortSignal; timeout?: number } {
  return {
    cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {})
  }
}

export function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function getErrorText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const parts: string[] = []
    if ('message' in error && typeof error.message === 'string') {
      parts.push(error.message)
    }
    if ('stderr' in error && typeof error.stderr === 'string') {
      parts.push(error.stderr)
    }
    return parts.join('\n')
  }
  return String(error)
}

export function isNotGitRepositoryError(error: unknown): boolean {
  return /not a git repository/i.test(getErrorText(error))
}

export function isBranchCheckedOutInWorktreeError(error: unknown): boolean {
  return /cannot delete branch .*(?:used by worktree|checked out)|branch .*is checked out/i.test(
    getErrorText(error)
  )
}

export function normalizeLocalBranchRef(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

export type { LocalBaseRefRefreshResult, LocalBaseRefUpdateSuggestion, RemoveWorktreeResult }
