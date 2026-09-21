import { getStatus } from '../git/status'
import { gitExecFileAsync } from '../git/runner'
import type { GitStatusResult } from '../../shared/git-status-types'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import type { WorkspaceCleanupBlocker } from '../../shared/workspace-cleanup'
import {
  WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
  WorkspaceCleanupScanCancelledError,
  withWorkspaceCleanupTimeout
} from './workspace-cleanup-scan-primitives'
import { getWorktreeSharedLinkPaths } from '../git/worktree-shared-directories'
import { SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE } from '../providers/ssh-git-dispatch'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import {
  resolveWorkspaceCleanupWorktreeGitRoute,
  type WorkspaceCleanupGitRoute,
  type WorkspaceCleanupWorktreeGitRoute
} from './workspace-cleanup-git-route'

export type WorkspaceCleanupGitEvidence = {
  clean: boolean | null
  upstreamAhead: number | null
  upstreamBehind: number | null
  checkedAt: number | null
  blockers: WorkspaceCleanupBlocker[]
}

export function createEmptyWorkspaceCleanupGitEvidence(): WorkspaceCleanupGitEvidence {
  return {
    clean: null,
    upstreamAhead: null,
    upstreamBehind: null,
    checkedAt: null,
    blockers: []
  }
}

export async function readWorkspaceCleanupGitEvidence(
  worktree: Worktree,
  repo: Repo,
  repoRoute: WorkspaceCleanupGitRoute,
  signal?: AbortSignal
): Promise<WorkspaceCleanupGitEvidence> {
  const blockers: WorkspaceCleanupBlocker[] = []
  let status: GitStatusResult
  const checkedAt = Date.now()
  const route = resolveWorkspaceCleanupWorktreeGitRoute(repoRoute, worktree, repo)
  if (route.kind === 'host-mismatch') {
    // Refusing beats reading one host's checkout and labelling the row with the other's.
    console.warn(
      `Workspace cleanup skipped git for ${worktree.id}: listed on ${route.listedHostId}, owned by ${route.hostId}`
    )
    return { ...createEmptyWorkspaceCleanupGitEvidence(), blockers: ['git-status-error'] }
  }
  // Shared links are this machine's symlink layout; no remote checkout inherits it.
  const sharedLinkPaths = route.kind === 'ssh' ? [] : getWorktreeSharedLinkPaths(repo)

  try {
    status = await withWorkspaceCleanupTimeout(
      (signal) =>
        route.kind === 'ssh'
          ? requireWorkspaceCleanupGitProvider(route).getStatus(worktree.path, {
              includeLineStats: false,
              signal
            })
          : getStatus(worktree.path, {
              includeLineStats: false,
              signal,
              ...(sharedLinkPaths.length > 0 ? { sharedLinkPaths } : {})
            }),
      WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
      'Timed out reading git status.',
      signal
    )
  } catch (error) {
    if (error instanceof WorkspaceCleanupScanCancelledError) {
      throw error
    }
    return {
      ...createEmptyWorkspaceCleanupGitEvidence(),
      blockers: ['git-status-error']
    }
  }

  if (status.upstreamStatus === undefined) {
    return {
      ...createEmptyWorkspaceCleanupGitEvidence(),
      blockers: ['git-status-error']
    }
  }

  const clean = status.entries.length === 0
  if (!clean) {
    blockers.push('dirty-files')
  }

  const upstreamAhead = status.upstreamStatus.hasUpstream ? status.upstreamStatus.ahead : null
  const upstreamBehind = status.upstreamStatus.hasUpstream ? status.upstreamStatus.behind : null
  if (upstreamAhead !== null && upstreamAhead > 0) {
    blockers.push('unpushed-commits')
  }
  if (clean && upstreamAhead === null) {
    const unpushedCommitCount = await readUnpushedCommitCount(worktree, route, signal)
    if (unpushedCommitCount === null) {
      blockers.push('unknown-base')
    } else if (unpushedCommitCount > 0) {
      blockers.push('unpushed-commits')
    }
  }

  return {
    clean,
    upstreamAhead,
    upstreamBehind,
    checkedAt,
    blockers: uniqueWorkspaceCleanupGitBlockers(blockers)
  }
}

async function readUnpushedCommitCount(
  worktree: Worktree,
  route: Exclude<WorkspaceCleanupWorktreeGitRoute, { kind: 'host-mismatch' }>,
  signal?: AbortSignal
): Promise<number | null> {
  try {
    const result = await withWorkspaceCleanupTimeout(
      (signal) =>
        route.kind === 'ssh'
          ? requireWorkspaceCleanupGitProvider(route).exec(
              ['rev-list', '--count', 'HEAD', '--not', '--remotes'],
              worktree.path,
              { signal }
            )
          : gitExecFileAsync(['rev-list', '--count', 'HEAD', '--not', '--remotes'], {
              cwd: worktree.path,
              signal
            }),
      WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
      'Timed out checking unpushed commits.',
      signal
    )
    const count = Number.parseInt(result.stdout.trim(), 10)
    return Number.isFinite(count) ? count : null
  } catch (error) {
    if (error instanceof WorkspaceCleanupScanCancelledError) {
      throw error
    }
    return null
  }
}

/** An unreachable remote host is an error, never a licence to read this machine's checkout. */
function requireWorkspaceCleanupGitProvider(
  route: Extract<WorkspaceCleanupGitRoute, { kind: 'ssh' }>
): SshGitProvider {
  if (!route.provider) {
    throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
  }
  return route.provider
}

function uniqueWorkspaceCleanupGitBlockers(
  blockers: WorkspaceCleanupBlocker[]
): WorkspaceCleanupBlocker[] {
  return [...new Set(blockers)]
}
