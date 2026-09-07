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
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { readWorktreeMetaForHost } from './persistence/host-qualified-worktree-meta'
import { getRepoOwnedWorktreeMeta } from './worktree-metadata-ownership'
import {
  resolveFilesystemRouteForHost,
  resolveGitRouteForHost
} from './providers/execution-host-provider-dispatch'
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

export function summarizeWorkspaceSpaceRows(
  rows: readonly WorkspaceSpaceWorktree[]
): Pick<
  WorkspaceSpaceRepoSummary,
  'scannedWorktreeCount' | 'unavailableWorktreeCount' | 'totalSizeBytes' | 'reclaimableBytes'
> {
  let scannedWorktreeCount = 0
  let unavailableWorktreeCount = 0
  let totalSizeBytes = 0
  let reclaimableBytes = 0
  for (const row of rows) {
    if (row.status === 'ok') {
      scannedWorktreeCount += 1
    } else {
      unavailableWorktreeCount += 1
    }
    totalSizeBytes += row.sizeBytes
    reclaimableBytes += row.reclaimableBytes
  }
  return {
    scannedWorktreeCount,
    unavailableWorktreeCount,
    totalSizeBytes,
    reclaimableBytes
  }
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
    // Why: the raw `connectionId` field answers "local" for a row that spells its owner only as
    // `executionHostId: 'ssh:<target>'`, which sizes a same-named path on this machine instead.
    const route = resolveGitRouteForHost(getRepoExecutionHostId(repo))
    if (route.kind === 'runtime') {
      return {
        ok: false,
        status: 'unavailable',
        error: `Host ${route.hostId} is not reachable from this process.`
      }
    }
    if (route.kind === 'ssh') {
      if (!route.provider) {
        return {
          ok: false,
          status: 'unavailable',
          error: `SSH connection "${route.connectionId}" is not connected.`
        }
      }
      const worktrees = await route.provider.listWorktrees(repo.path, { signal })
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
  const executionHostId = getRepoExecutionHostId(repo)
  const repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
  const allMeta = store.getAllWorktreeMeta?.()
  const legacyMeta = store.getWorktreeMeta?.(worktreeId)
  const metaById = allMeta ?? (legacyMeta ? { [worktreeId]: legacyMeta } : {})
  const meta =
    readWorktreeMetaForHost(store, worktreeId, executionHostId) ??
    getRepoOwnedWorktreeMeta(repo, worktreeId, metaById, repoOwnerCount)
  return mergeWorktree(repo.id, gitWorktree, meta, repo.displayName)
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
        isRemote: getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID,
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
  const filesystemRoute = resolveFilesystemRouteForHost(getRepoExecutionHostId(repo))
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
    const row =
      filesystemRoute.kind !== 'local'
        ? filesystemRoute.kind === 'ssh' && filesystemRoute.provider
          ? await scanRemoteWorkspaceSpaceWorktree(
              repo,
              worktree,
              scannedAt,
              filesystemRoute.provider,
              limiters.remoteFallbackTraversal,
              options.signal
            )
          : createUnavailableWorkspaceSpaceRow(
              repo,
              worktree,
              scannedAt,
              'unavailable',
              filesystemRoute.kind === 'ssh'
                ? `SSH filesystem for "${filesystemRoute.connectionId}" is not connected.`
                : `Host ${filesystemRoute.hostId} is not reachable from this process.`
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
  const summary = summarizeWorkspaceSpaceRows(rows)
  return {
    worktrees: rows,
    summary: {
      repoId: repo.id,
      executionHostId: getRepoExecutionHostId(repo),
      displayName: repo.displayName,
      path: repo.path,
      isRemote: getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID,
      worktreeCount: rows.length,
      ...summary,
      error: null
    }
  }
}
