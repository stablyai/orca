import type { Repo } from '../../shared/repo-types'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { splitWorktreeId } from '../../shared/worktree/id'
import type { GitPushTarget } from '../../shared/worktree/types'

export type RuntimeWorktreeRemovalTarget = {
  id: string
  repoId: string
  path: string
  pushTarget?: GitPushTarget
}

/** Named options prevent interchangeable safety-waiver booleans from silently authorizing the wrong destructive delete. */
export type RemoveManagedWorktreeOptions = {
  force?: boolean
  runHooks?: boolean
  /** Waives proof that every PTY stopped (#11960). Set by explicit Force Delete only. */
  allowUnverifiedPtyStop?: boolean
  /** Waives a FAILED archive hook (#19334). Never implied by `force`, never by `runHooks`. */
  allowFailedArchiveHook?: boolean
  hostId?: string
  /** Reply with the finished delete's result; otherwise a background delete replies on acceptance. */
  waitForBackgroundRemoval?: boolean
}

export function getRuntimeWorktreeRemovalOptionsKey(
  options: Pick<
    RemoveManagedWorktreeOptions,
    'force' | 'runHooks' | 'allowUnverifiedPtyStop' | 'allowFailedArchiveHook'
  >
): string {
  // Forced retries must not coalesce onto an attempt refusing unverified PTY stop.
  const ptyKey = options.allowUnverifiedPtyStop ? 'allow-unverified-pty' : 'require-pty-stop'
  // Archive-waiver retries must not inherit an in-flight attempt's hook refusal.
  const archiveKey = options.allowFailedArchiveHook ? 'allow-failed-archive' : 'require-archive'
  const hooksKey = options.runHooks ? 'run-hooks' : 'skip-hooks'
  return `${options.force ? 'force' : 'normal'}:${hooksKey}:${ptyKey}:${archiveKey}`
}

// Null host is host-unaware; unstamped legacy rows are adoptable, but either explicit host spelling must match exactly.
export function runtimeRepoMatchesExecutionHost(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>,
  executionHostId?: ExecutionHostId | null
): boolean {
  if (executionHostId == null) {
    return true
  }
  if (repo.executionHostId == null && repo.connectionId == null) {
    return true
  }
  return getRepoExecutionHostId(repo) === executionHostId
}

/** Registration reads this machine's path; an SSH row at that path belongs to another machine. */
export function runtimeRepoIsRegistrationCandidate(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>,
  executionHostId?: ExecutionHostId | null
): boolean {
  return runtimeRepoMatchesExecutionHost(repo, executionHostId) && !getRepoSshConnectionId(repo)
}

export function parseExactWorktreeIdSelector(
  selector: string
): RuntimeWorktreeRemovalTarget | null {
  const worktreeId = selector.startsWith('id:') ? selector.slice(3) : selector
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed || !parsed.repoId || !parsed.worktreePath) {
    return null
  }
  return {
    id: worktreeId,
    repoId: parsed.repoId,
    path: parsed.worktreePath
  }
}

export function normalizeLocalBranchName(branchName: string | undefined): string {
  return branchName?.replace(/^refs\/heads\//, '') ?? ''
}

export function getExplicitWorktreeIdSelector(selector: string | undefined): string | null {
  if (!selector?.startsWith('id:')) {
    return null
  }
  const id = selector.slice(3)
  return id.length > 0 ? id : null
}

export function hasLocalGitOptions(gitOptions: { wslDistro?: string }): boolean {
  return Object.keys(gitOptions).length > 0
}
