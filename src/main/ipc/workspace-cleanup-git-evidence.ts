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
import { readWorkspaceCleanupMergeVerdict } from './workspace-cleanup-merge-probe'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'

export type WorkspaceCleanupGitEvidence = {
  clean: boolean | null
  upstreamAhead: number | null
  upstreamBehind: number | null
  merged: boolean | null
  checkedAt: number | null
  blockers: WorkspaceCleanupBlocker[]
}

export function createEmptyWorkspaceCleanupGitEvidence(): WorkspaceCleanupGitEvidence {
  return {
    clean: null,
    upstreamAhead: null,
    upstreamBehind: null,
    merged: null,
    checkedAt: null,
    blockers: []
  }
}

export async function readWorkspaceCleanupGitEvidence(
  worktree: Worktree,
  repo: Repo,
  provider: IGitProvider | null,
  signal?: AbortSignal,
  localGitOptions: LocalProjectWorktreeGitOptions = {}
): Promise<WorkspaceCleanupGitEvidence> {
  const blockers: WorkspaceCleanupBlocker[] = []
  let status: GitStatusResult
  const checkedAt = Date.now()
  const sharedLinkPaths = repo.connectionId ? [] : getWorktreeSharedLinkPaths(repo)

  try {
    status = await withWorkspaceCleanupTimeout(
      (signal) =>
        repo.connectionId
          ? provider!.getStatus(worktree.path, { includeLineStats: false, signal })
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
  // Why: a dirty workspace is blocked by dirty-files whatever the merge says, so
  // the probe would only spend Git processes to change nothing.
  const merged = clean ? await readMergeVerdict(worktree, repo, localGitOptions) : null

  // Why: a squash or rebase merge rewrites the branch's commits, so they exist
  // nowhere on a remote in their original form and the deleted PR branch leaves
  // no upstream — the shape that made these two blockers fire on exactly the
  // workspaces this cleanup exists to retire. The merge proof already
  // established the base carries every change, so there is nothing to lose.
  if (merged !== true) {
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
  }

  return {
    clean,
    upstreamAhead,
    upstreamBehind,
    merged,
    checkedAt,
    blockers: uniqueWorkspaceCleanupGitBlockers(blockers)
  }
}

async function readMergeVerdict(
  worktree: Worktree,
  repo: Repo,
  localGitOptions: LocalProjectWorktreeGitOptions
): Promise<boolean | null> {
  try {
    return await withWorkspaceCleanupTimeout(
      (signal) => readWorkspaceCleanupMergeVerdict(worktree, repo, { ...localGitOptions, signal }),
      WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
      'Timed out checking whether the branch is merged.'
    )
  } catch {
    // Why: an unknown verdict keeps the pre-existing blocker behavior, so a slow
    // probe degrades to today's classification instead of widening deletion.
    return null
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
