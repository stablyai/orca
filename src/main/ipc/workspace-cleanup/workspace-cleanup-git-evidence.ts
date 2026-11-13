import { getStatus } from '../../git/source-control/status/status-read'
import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'
import type { GitStatusResult } from '../../../shared/git/status/git-status-types'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { PRInfo } from '../../../shared/github/pull-requests/pull-request-types'
import type { PRCacheView } from '../../../shared/sidebar-list/feed-facts/workspace-review-facts'
import {
  isWorkspaceCleanupHeadLanded,
  type WorkspaceCleanupBlocker,
  type WorkspaceCleanupMergeEvidence
} from '../../../shared/workspace-cleanup/workspace-cleanup'
import {
  readWorkspaceCleanupMergeEvidence,
  type WorkspaceCleanupRepoRefs
} from './workspace-cleanup-merge-evidence'
import {
  hasWorktreeAtRiskLocalFiles,
  type WorktreeAtRiskLocalFiles
} from '../../../shared/worktree/removal/at-risk-local-files'
import { readWorktreeAtRiskLocalFiles } from '../../git/worktrees/removal/worktree-at-risk-local-files'
import {
  WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
  WorkspaceCleanupScanCancelledError,
  throwIfWorkspaceCleanupScanAborted,
  withWorkspaceCleanupTimeout
} from './workspace-cleanup-scan-primitives'
import { getWorktreeSharedLinkPaths } from '../../git/worktrees/content-paths/worktree-shared-directories'
import {
  resolveWorkspaceCleanupWorktreeGitRoute,
  type WorkspaceCleanupGitRoute
} from './workspace-cleanup-git-route'

export type WorkspaceCleanupGitEvidence = {
  clean: boolean | null
  upstreamAhead: number | null
  upstreamBehind: number | null
  checkedAt: number | null
  merge?: WorkspaceCleanupMergeEvidence
  atRiskLocalFiles: WorktreeAtRiskLocalFiles | null
  blockers: WorkspaceCleanupBlocker[]
}

export function createEmptyWorkspaceCleanupGitEvidence(): WorkspaceCleanupGitEvidence {
  return {
    clean: null,
    upstreamAhead: null,
    upstreamBehind: null,
    checkedAt: null,
    atRiskLocalFiles: null,
    blockers: []
  }
}

export async function readWorkspaceCleanupGitEvidence(
  worktree: Worktree,
  repo: Repo,
  repoRoute: WorkspaceCleanupGitRoute,
  prCache: PRCacheView<PRInfo>,
  repoRefs: WorkspaceCleanupRepoRefs,
  signal?: AbortSignal,
  coordinatorBranch?: string | null
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
  // An unreachable remote host is an error, never a licence to read this machine's checkout.
  if (route.kind === 'ssh') {
    return {
      ...createEmptyWorkspaceCleanupGitEvidence(),
      blockers: ['git-status-error']
    }
  }
  const sharedLinkPaths = getWorktreeSharedLinkPaths(repo)

  try {
    status = await withWorkspaceCleanupTimeout(
      (signal) =>
        getStatus(worktree.path, {
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
  const merge = await readWorkspaceCleanupMergeEvidence(
    worktree,
    repo,
    prCache,
    repoRefs,
    signal,
    coordinatorBranch
  )
  // Commits already in the base, a merged review or the coordinator's branch are not at risk, even after a squash rewrote them.
  const headLanded = isWorkspaceCleanupHeadLanded(merge)
  if (!headLanded && upstreamAhead !== null && upstreamAhead > 0) {
    blockers.push('unpushed-commits')
  } else if (!headLanded && clean) {
    // A deleted remote branch still reads as an upstream 0 ahead; only `--remotes` proves the commits exist there.
    const unpushedCommitCount = await readUnpushedCommitCount(worktree, signal)
    if (unpushedCommitCount === null) {
      blockers.push('unknown-base')
    } else if (unpushedCommitCount > 0) {
      blockers.push('unpushed-commits')
    }
  }

  const atRiskLocalFiles = await readCleanupAtRiskLocalFiles(worktree, repo, signal)
  if (hasWorktreeAtRiskLocalFiles(atRiskLocalFiles)) {
    blockers.push('ignored-files')
  }

  return {
    clean,
    upstreamAhead,
    upstreamBehind,
    checkedAt,
    ...(merge ? { merge } : {}),
    atRiskLocalFiles,
    blockers: uniqueWorkspaceCleanupGitBlockers(blockers)
  }
}

async function readCleanupAtRiskLocalFiles(
  worktree: Worktree,
  repo: Repo,
  signal?: AbortSignal
): Promise<WorktreeAtRiskLocalFiles> {
  try {
    return await readWorktreeAtRiskLocalFiles({
      worktreePath: worktree.path,
      mainCheckoutPath: repo.path,
      gitOptions: signal ? { signal } : {},
      deadlineMs: WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS
    })
  } catch (error) {
    throwIfWorkspaceCleanupScanAborted(signal)
    throw error
  }
}

async function readUnpushedCommitCount(
  worktree: Worktree,
  signal?: AbortSignal
): Promise<number | null> {
  try {
    const result = await withWorkspaceCleanupTimeout(
      (signal) =>
        gitExecFileAsync(['rev-list', '--count', 'HEAD', '--not', '--remotes'], {
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
