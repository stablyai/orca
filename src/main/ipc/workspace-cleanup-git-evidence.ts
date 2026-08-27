import { getStatus } from '../git/status'
import { gitExecFileAsync } from '../git/runner'
import type { IGitProvider } from '../providers/types'
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
  provider: IGitProvider | null,
  signal?: AbortSignal
): Promise<WorkspaceCleanupGitEvidence> {
  const blockers: WorkspaceCleanupBlocker[] = []
  let status: GitStatusResult
  const checkedAt = Date.now()
  const sharedLinkPaths = repo.connectionId ? [] : getWorktreeSharedLinkPaths(repo)

  try {
    status = await withWorkspaceCleanupTimeout(
      (signal) =>
        repo.connectionId
          ? provider!.getStatus(worktree.path, { signal })
          : getStatus(worktree.path, {
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
    const unpushedCommitCount = await readUnpushedCommitCount(worktree, repo, provider, signal)
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
  repo: Repo,
  provider: IGitProvider | null,
  signal?: AbortSignal
): Promise<number | null> {
  try {
    const result = await withWorkspaceCleanupTimeout(
      (signal) =>
        repo.connectionId
          ? provider!.exec(['rev-list', '--count', 'HEAD', '--not', '--remotes'], worktree.path, {
              signal
            })
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

function uniqueWorkspaceCleanupGitBlockers(
  blockers: WorkspaceCleanupBlocker[]
): WorkspaceCleanupBlocker[] {
  return [...new Set(blockers)]
}
