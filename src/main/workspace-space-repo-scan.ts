import type { Store } from './persistence'
import { isFolderRepo } from '../shared/repo-kind'
import type { Repo } from '../shared/repo-types'
import type { GitWorktreeInfo, Worktree } from '../shared/worktree/types'
import type {
  WorkspaceSpaceRepoSummary,
  WorkspaceSpaceScanProgress,
  WorkspaceSpaceScanStatus,
  WorkspaceSpaceWorktree
} from '../shared/workspace-space-types'
import { mapWithConcurrency } from '../shared/map-with-concurrency'
import { getRepoExecutionHostId } from '../shared/execution-host'
import { getSshFilesystemProvider } from './providers/ssh-filesystem-dispatch'
import { getSshGitProvider } from './providers/ssh-git-dispatch'
import { createFolderWorktree, listRepoWorktrees } from './repo-worktrees'
import { mergeWorktree } from './ipc/worktree-logic'
import { getLocalProjectWorktreeGitOptions } from './project-runtime-git-options'
import {
  WorkspaceSpaceScanCancelledError,
  classifyWorkspaceSpaceError,
  throwIfWorkspaceSpaceScanAborted,
  type AsyncLimiter
} from './workspace-space-scan-control'
import { createUnavailableWorkspaceSpaceRow } from './workspace-space-worktree-row'
import { scanRemoteWorkspaceSpaceWorktree } from './workspace-space-remote-scan'
import {
  scanLocalWorkspaceSpaceWorktree,
  type ReadLocalDuDepthOne
} from './workspace-space-local-scan'

const WORKTREE_SCAN_CONCURRENCY = 3

type WorktreeListResult =
  | { ok: true; worktrees: GitWorktreeInfo[] }
  | { ok: false; status: Exclude<WorkspaceSpaceScanStatus, 'ok'>; error: string }

export type WorkspaceSpaceAnalyzeOptions = {
  signal?: AbortSignal
  scanId?: string
  onProgress?: (progress: WorkspaceSpaceScanProgress) => void
}

export type WorkspaceSpaceScanLimiters = {
  localWorktree: AsyncLimiter
  remoteFallbackTraversal: AsyncLimiter
}

export type WorkspaceSpaceRepoScanResult = {
  summary: WorkspaceSpaceRepoSummary
  worktrees: WorkspaceSpaceWorktree[]
}

async function listWorktreesForSpaceScan(
  store: Store,
  repo: Repo,
  signal?: AbortSignal
): Promise<WorktreeListResult> {
  try {
    throwIfWorkspaceSpaceScanAborted(signal)
    if (isFolderRepo(repo)) {
      return { ok: true, worktrees: [createFolderWorktree(repo)] }
    }
    if (repo.connectionId) {
      const provider = getSshGitProvider(repo.connectionId)
      if (!provider) {
        return {
          ok: false,
          status: 'unavailable',
          error: `SSH connection "${repo.connectionId}" is not connected.`
        }
      }
      const worktrees = await provider.listWorktrees(repo.path, { signal })
      throwIfWorkspaceSpaceScanAborted(signal)
      return { ok: true, worktrees }
    }
    const worktrees = await listRepoWorktrees(repo, {
      ...getLocalProjectWorktreeGitOptions(store, repo),
      signal
    })
    throwIfWorkspaceSpaceScanAborted(signal)
    return { ok: true, worktrees }
  } catch (error) {
    if (error instanceof WorkspaceSpaceScanCancelledError) {
      throw error
    }
    const classified = classifyWorkspaceSpaceError(error)
    return { ok: false, status: classified.status, error: classified.message }
  }
}

function reportProgress(
  progress: WorkspaceSpaceScanProgress,
  updates: Partial<WorkspaceSpaceScanProgress>,
  onProgress: WorkspaceSpaceAnalyzeOptions['onProgress']
): void {
  const completedMeasurements = updates.completedMeasurements
  Object.assign(progress, updates, { updatedAt: Date.now() })
  delete progress.completedMeasurements
  onProgress?.({
    ...progress,
    ...(completedMeasurements?.length ? { completedMeasurements } : {})
  })
}

function mergeForSpaceScan(repo: Repo, gitWorktree: GitWorktreeInfo, store: Store): Worktree {
  const worktreeId = `${repo.id}::${gitWorktree.path}`
  return mergeWorktree(repo.id, gitWorktree, store.getWorktreeMeta(worktreeId), repo.displayName)
}

export async function scanWorkspaceSpaceRepo(args: {
  repo: Repo
  scannedAt: number
  store: Store
  limiters: WorkspaceSpaceScanLimiters
  progress: WorkspaceSpaceScanProgress
  options: WorkspaceSpaceAnalyzeOptions
  readLocalDuDepthOne: ReadLocalDuDepthOne
  normalizeLocalDuPath: (path: string) => string
}): Promise<WorkspaceSpaceRepoScanResult> {
  const { repo, scannedAt, store, limiters, progress, options } = args
  throwIfWorkspaceSpaceScanAborted(options.signal)
  reportProgress(
    progress,
    { currentRepoDisplayName: repo.displayName, currentWorktreeDisplayName: null },
    options.onProgress
  )
  const listed = await listWorktreesForSpaceScan(store, repo, options.signal)
  if (!listed.ok) {
    reportProgress(
      progress,
      { scannedRepoCount: progress.scannedRepoCount + 1 },
      options.onProgress
    )
    return {
      worktrees: [],
      summary: {
        repoId: repo.id,
        executionHostId: getRepoExecutionHostId(repo),
        displayName: repo.displayName,
        path: repo.path,
        isRemote: Boolean(repo.connectionId),
        worktreeCount: 0,
        scannedWorktreeCount: 0,
        unavailableWorktreeCount: 1,
        totalSizeBytes: 0,
        reclaimableBytes: 0,
        error: listed.error
      }
    }
  }
  const worktrees = listed.worktrees
    .filter((gitWorktree) => !gitWorktree.prunable)
    .map((gitWorktree) => mergeForSpaceScan(repo, gitWorktree, store))
  reportProgress(
    progress,
    { totalWorktreeCount: progress.totalWorktreeCount + worktrees.length },
    options.onProgress
  )
  const remoteProvider = repo.connectionId ? getSshFilesystemProvider(repo.connectionId) : undefined
  const rows = await mapWithConcurrency(worktrees, WORKTREE_SCAN_CONCURRENCY, async (worktree) => {
    throwIfWorkspaceSpaceScanAborted(options.signal)
    reportProgress(
      progress,
      {
        currentRepoDisplayName: repo.displayName,
        currentWorktreeDisplayName: worktree.displayName
      },
      options.onProgress
    )
    const row = repo.connectionId
      ? remoteProvider
        ? await scanRemoteWorkspaceSpaceWorktree(
            repo,
            worktree,
            scannedAt,
            remoteProvider,
            limiters.remoteFallbackTraversal,
            options.signal
          )
        : createUnavailableWorkspaceSpaceRow(
            repo,
            worktree,
            scannedAt,
            'unavailable',
            `SSH filesystem for "${repo.connectionId}" is not connected.`
          )
      : await limiters.localWorktree(() =>
          scanLocalWorkspaceSpaceWorktree(
            repo,
            worktree,
            scannedAt,
            args.readLocalDuDepthOne,
            args.normalizeLocalDuPath,
            options.signal
          )
        )
    reportProgress(
      progress,
      {
        scannedWorktreeCount: progress.scannedWorktreeCount + 1,
        completedMeasurements: [
          {
            worktreeId: row.worktreeId,
            executionHostId: row.executionHostId,
            status: row.status,
            sizeBytes: row.sizeBytes
          }
        ]
      },
      options.onProgress
    )
    return row
  })
  reportProgress(
    progress,
    {
      scannedRepoCount: progress.scannedRepoCount + 1,
      currentRepoDisplayName: repo.displayName,
      currentWorktreeDisplayName: null
    },
    options.onProgress
  )
  return {
    worktrees: rows,
    summary: {
      repoId: repo.id,
      executionHostId: getRepoExecutionHostId(repo),
      displayName: repo.displayName,
      path: repo.path,
      isRemote: Boolean(repo.connectionId),
      worktreeCount: rows.length,
      scannedWorktreeCount: rows.filter((row) => row.status === 'ok').length,
      unavailableWorktreeCount: rows.filter((row) => row.status !== 'ok').length,
      totalSizeBytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0),
      reclaimableBytes: rows.reduce((sum, row) => sum + row.reclaimableBytes, 0),
      error: null
    }
  }
}
