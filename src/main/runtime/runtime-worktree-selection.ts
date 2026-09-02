import type { Repo } from '../../shared/repo-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { splitWorktreeId } from '../../shared/worktree/id'
import type { GitPushTarget } from '../../shared/worktree/types'

export type RuntimeWorktreeRemovalTarget = {
  id: string
  repoId: string
  path: string
  pushTarget?: GitPushTarget
}

export function gitStatusErrorMeansNotRepository(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : typeof error === 'string'
          ? error
          : ''
  const stderr =
    error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr: unknown }).stderr)
      : ''
  return /not a git repository/i.test(`${message}\n${stderr}`)
}

export function getRuntimeWorktreeRemovalOptionsKey(
  force: boolean,
  runHooks: boolean,
  allowUnverifiedPtyStop: boolean
): string {
  // Why: a forced retry must not coalesce onto the in-flight attempt that just
  // failed the PTY gate — it would inherit that failure instead of retrying.
  const ptyKey = allowUnverifiedPtyStop ? 'allow-unverified-pty' : 'require-pty-stop'
  return `${force ? 'force' : 'normal'}:${runHooks ? 'run-hooks' : 'skip-hooks'}:${ptyKey}`
}

// Null executionHostId means host-unaware: path-only callers match any repo, and the first runtime
// host can adopt a legacy (unstamped) repo. But an unstamped repo with a connectionId is an SSH repo
// (resolves to ssh:<id>), so it must not be adopted/matched by a runtime host at the same path.
export function runtimeRepoMatchesExecutionHost(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>,
  executionHostId?: ExecutionHostId | null
): boolean {
  if (executionHostId == null) {
    return true
  }
  if (repo.executionHostId != null) {
    return repo.executionHostId === executionHostId
  }
  return repo.connectionId == null
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
