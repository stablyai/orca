import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import { resolveDefaultBaseRefViaExec } from '../../shared/git-default-base-ref'
import { parseGitRevListAheadBehindCounts } from '../../shared/git-rev-list-output'
import { gitExecFileAsync } from '../git/runner'
import { SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE } from '../providers/ssh-git-dispatch'
import type { WorkspaceCleanupGitRoute } from './workspace-cleanup-git-route'
import {
  WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
  WorkspaceCleanupScanCancelledError,
  withWorkspaceCleanupTimeout
} from './workspace-cleanup-scan-primitives'

/** Resolves the ref a worktree's branch is compared against; null when none can be named. */
export type WorkspaceCleanupBaseRefResolver = (
  worktree: Pick<Worktree, 'baseRef' | 'sparseBaseRef'>
) => Promise<string | null>

type MergeCheckedWorktree = Pick<Worktree, 'path' | 'branch' | 'isMainWorktree' | 'prunable'>

/** One bounded, timeout-guarded git read on the host that owns the checkout. */
export async function execWorkspaceCleanupGitRead(
  route: WorkspaceCleanupGitRoute,
  argv: string[],
  cwd: string,
  timeoutMessage: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const result = await withWorkspaceCleanupTimeout(
      (timeoutSignal) => {
        if (route.kind === 'local') {
          return gitExecFileAsync(argv, { cwd, signal: timeoutSignal })
        }
        if (!route.provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return route.provider.exec(argv, cwd, { signal: timeoutSignal })
      },
      WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
      timeoutMessage,
      signal
    )
    return result.stdout
  } catch (error) {
    if (error instanceof WorkspaceCleanupScanCancelledError) {
      throw error
    }
    return null
  }
}

/** Same precedence as the worktree drift probe: worktree base, repo base, then the default. */
export function createWorkspaceCleanupBaseRefResolver(
  repo: Pick<Repo, 'path' | 'worktreeBaseRef'>,
  route: WorkspaceCleanupGitRoute,
  signal?: AbortSignal
): WorkspaceCleanupBaseRefResolver {
  let defaultBaseRef: Promise<string | null> | undefined
  return (worktree) => {
    const configured = worktree.baseRef || worktree.sparseBaseRef || repo.worktreeBaseRef
    if (configured) {
      return Promise.resolve(configured)
    }
    // Why once per repo: every worktree shares the repo's default branch.
    defaultBaseRef ??= resolveDefaultBaseRefViaExec(async (argv) => {
      const stdout = await execWorkspaceCleanupGitRead(
        route,
        argv,
        repo.path,
        'Timed out resolving the default branch.',
        signal
      )
      if (stdout === null) {
        throw new Error('default branch unavailable')
      }
      return { stdout }
    })
    return defaultBaseRef
  }
}

/**
 * True when every commit on the worktree's branch is already reachable from `baseRef`.
 *
 * Ancestry only: a squash or rebase merge rewrites commits, so those branches read as not merged
 * here. A branch that never moved since it was created has no work of its own and is not called
 * merged either, which keeps a fresh worktree from looking finished.
 */
export async function isWorkspaceCleanupBranchMerged(
  worktree: MergeCheckedWorktree,
  baseRef: string,
  route: WorkspaceCleanupGitRoute,
  signal?: AbortSignal
): Promise<boolean> {
  const branch = worktree.branch.replace(/^refs\/heads\//, '')
  if (
    !worktree.branch.startsWith('refs/heads/') ||
    !branch ||
    worktree.isMainWorktree ||
    worktree.prunable === true ||
    baseRef === branch ||
    baseRef.endsWith(`/${branch}`)
  ) {
    return false
  }
  const counts = await execWorkspaceCleanupGitRead(
    route,
    ['rev-list', '--left-right', '--count', `HEAD...${baseRef}`, '--'],
    worktree.path,
    'Timed out checking merge state.',
    signal
  )
  const parsed = counts === null ? null : parseGitRevListAheadBehindCounts(counts)
  if (parsed?.status !== 'ok' || parsed.ahead > 0) {
    return false
  }
  // Why two entries: the creation entry alone means the branch never moved on its own.
  const reflog = await execWorkspaceCleanupGitRead(
    route,
    ['reflog', 'show', '-n', '2', '--format=%H', `refs/heads/${branch}`, '--'],
    worktree.path,
    'Timed out checking branch history.',
    signal
  )
  const entries = reflog === null ? 0 : reflog.split('\n').filter((line) => line.trim()).length
  if (entries === 1) {
    return false
  }
  // Without a reflog (expired, or a bare repo) only a branch the base has moved past counts.
  return entries >= 2 || parsed.behind > 0
}
