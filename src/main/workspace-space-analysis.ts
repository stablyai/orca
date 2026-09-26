import { platform } from 'node:process'
import type { Store } from './persistence'
import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceScanProgress
} from '../shared/workspace-space-types'
import { mapWithConcurrency } from '../shared/map-with-concurrency'
import { escapeRegex } from '../shared/string-utils'
import {
  readWorkspaceSpaceDuDepthOne,
  WorkspaceSpaceDuTimeoutError
} from '../shared/workspace-space-du-stream'
import {
  WorkspaceSpaceScanCancelledError,
  createWorkspaceSpaceScanLimiter,
  throwIfWorkspaceSpaceScanAborted
} from './workspace-space-scan-control'
import {
  scanWorkspaceSpaceRepo,
  summarizeWorkspaceSpaceRows,
  type WorkspaceSpaceAnalyzeOptions,
  type WorkspaceSpaceScanLimiters
} from './workspace-space-repo-scan'

const REPO_SCAN_CONCURRENCY = 2
const LOCAL_WORKTREE_SCAN_CONCURRENCY = 1
const REMOTE_FALLBACK_SCAN_CONCURRENCY = 2

export { WorkspaceSpaceScanCancelledError, WorkspaceSpaceDuTimeoutError }

function normalizeLocalDuPath(pathValue: string): string {
  const separator = platform === 'win32' ? '\\' : '/'
  const trimmed = pathValue.replace(new RegExp(`${escapeRegex(separator)}+$`), '')
  return trimmed.length > 0 ? trimmed : pathValue
}

async function readLocalDuDepthOne(
  rootPath: string,
  signal?: AbortSignal
): Promise<Map<string, number>> {
  return readWorkspaceSpaceDuDepthOne(rootPath, {
    signal,
    normalizePath: normalizeLocalDuPath,
    createCancelledError: () => new WorkspaceSpaceScanCancelledError()
  })
}

export async function analyzeWorkspaceSpace(
  store: Store,
  options: WorkspaceSpaceAnalyzeOptions = {}
): Promise<WorkspaceSpaceAnalysis> {
  throwIfWorkspaceSpaceScanAborted(options.signal)
  const scannedAt = Date.now()
  const reposToScan = store.getRepos()
  const progress: WorkspaceSpaceScanProgress = {
    scanId: options.scanId ?? String(scannedAt),
    state: 'running',
    startedAt: scannedAt,
    updatedAt: scannedAt,
    totalRepoCount: reposToScan.length,
    scannedRepoCount: 0,
    totalWorktreeCount: 0,
    scannedWorktreeCount: 0,
    currentRepoDisplayName: null,
    currentWorktreeDisplayName: null
  }
  options.onProgress?.({ ...progress })
  const limiters: WorkspaceSpaceScanLimiters = {
    localWorktree: createWorkspaceSpaceScanLimiter(LOCAL_WORKTREE_SCAN_CONCURRENCY, options.signal),
    remoteFallbackTraversal: createWorkspaceSpaceScanLimiter(
      REMOTE_FALLBACK_SCAN_CONCURRENCY,
      options.signal
    )
  }
  const repoResults = await mapWithConcurrency(reposToScan, REPO_SCAN_CONCURRENCY, (repo) =>
    scanWorkspaceSpaceRepo({
      repo,
      scannedAt,
      store,
      limiters,
      progress,
      options,
      readLocalDuDepthOne,
      normalizeLocalDuPath
    })
  )
  throwIfWorkspaceSpaceScanAborted(options.signal)
  const repos = repoResults.map((result) => result.summary)
  const worktrees = repoResults
    .flatMap((result) => result.worktrees)
    .sort((a, b) => b.sizeBytes - a.sizeBytes || a.displayName.localeCompare(b.displayName))
  throwIfWorkspaceSpaceScanAborted(options.signal)
  const summary = summarizeWorkspaceSpaceRows(worktrees)
  let unavailableRepoCount = 0
  for (const repo of repos) {
    if (repo.error !== null) {
      unavailableRepoCount += 1
    }
  }
  return {
    scannedAt,
    totalSizeBytes: summary.totalSizeBytes,
    reclaimableBytes: summary.reclaimableBytes,
    worktreeCount: worktrees.length,
    scannedWorktreeCount: summary.scannedWorktreeCount,
    unavailableWorktreeCount: summary.unavailableWorktreeCount + unavailableRepoCount,
    repos,
    worktrees
  }
}
