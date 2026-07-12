import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { Repo, Worktree } from '../../shared/types'
import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceAnalyzeResult,
  WorkspaceSpaceRepoSummary,
  WorkspaceSpaceScanProgress,
  WorkspaceSpaceWorktree
} from '../../shared/workspace-space-types'
import {
  analyzeWorkspaceSpace,
  WorkspaceSpaceScanCancelledError
} from '../workspace-space-analysis'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'

const PROGRESS_EMIT_INTERVAL_MS = 100
/** Disk walks on large remote fleets can exceed the default 15s RPC budget. */
const REMOTE_WORKSPACE_SPACE_TIMEOUT_MS = 5 * 60_000

type InFlightWorkspaceSpaceScan = {
  scanId: string
  controller: AbortController
  progress: WorkspaceSpaceScanProgress
  promise: Promise<WorkspaceSpaceAnalyzeResult>
}

type RuntimeRpcResponse = {
  ok: boolean
  result?: unknown
  error?: { message?: string }
}

function isWorkspaceSpaceAnalysis(value: unknown): value is WorkspaceSpaceAnalysis {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.scannedAt === 'number' &&
    Array.isArray(record.worktrees) &&
    Array.isArray(record.repos)
  )
}

async function callRuntime(
  environmentId: string,
  method: string,
  params: unknown,
  timeoutMs = REMOTE_WORKSPACE_SPACE_TIMEOUT_MS
): Promise<RuntimeRpcResponse> {
  return (await callRuntimeEnvironment(
    app.getPath('userData'),
    environmentId,
    method,
    params,
    timeoutMs
  )) as RuntimeRpcResponse
}

/**
 * Inventory-only fallback for runtimes that do not yet expose
 * workspaceSpace.analyze. Still surfaces worktree rows so Review is not empty.
 */
async function inventoryRuntimeWorkspaces(
  environmentId: string
): Promise<WorkspaceSpaceAnalysis | null> {
  const reposResponse = await callRuntime(environmentId, 'repo.list', null, 30_000)
  if (
    reposResponse.ok !== true ||
    !reposResponse.result ||
    typeof reposResponse.result !== 'object'
  ) {
    return null
  }
  const reposRaw = (reposResponse.result as { repos?: Repo[] }).repos
  if (!Array.isArray(reposRaw)) {
    return null
  }

  const scannedAt = Date.now()
  const repoSummaries: WorkspaceSpaceRepoSummary[] = []
  const worktreeRows: WorkspaceSpaceWorktree[] = []

  for (const repo of reposRaw) {
    let worktrees: Worktree[] = []
    try {
      const wtResponse = await callRuntime(
        environmentId,
        'worktree.list',
        { repo: repo.id, limit: 500 },
        60_000
      )
      if (wtResponse.ok === true && wtResponse.result && typeof wtResponse.result === 'object') {
        const listed = (wtResponse.result as { worktrees?: Worktree[] }).worktrees
        if (Array.isArray(listed)) {
          worktrees = listed
        }
      }
    } catch {
      worktrees = []
    }

    for (const worktree of worktrees) {
      worktreeRows.push({
        worktreeId: worktree.id,
        repoId: repo.id,
        repoDisplayName: repo.displayName,
        repoPath: repo.path,
        displayName: worktree.displayName,
        path: worktree.path,
        branch: worktree.branch,
        isMainWorktree: worktree.isMainWorktree,
        isRemote: true,
        isSparse: false,
        canDelete: !worktree.isMainWorktree,
        lastActivityAt: worktree.lastActivityAt ?? scannedAt,
        status: 'unavailable',
        error: 'Disk sizes require a runtime build with workspaceSpace.analyze; inventory only.',
        scannedAt,
        sizeBytes: 0,
        reclaimableBytes: 0,
        skippedEntryCount: 0,
        topLevelItems: [],
        omittedTopLevelItemCount: 0,
        omittedTopLevelSizeBytes: 0
      })
    }

    repoSummaries.push({
      repoId: repo.id,
      displayName: repo.displayName,
      path: repo.path,
      isRemote: true,
      worktreeCount: worktrees.length,
      scannedWorktreeCount: 0,
      unavailableWorktreeCount: worktrees.length,
      totalSizeBytes: 0,
      reclaimableBytes: 0,
      error:
        worktrees.length === 0
          ? null
          : 'Disk sizes require a runtime build with workspaceSpace.analyze'
    })
  }

  return {
    scannedAt,
    totalSizeBytes: 0,
    reclaimableBytes: 0,
    worktreeCount: worktreeRows.length,
    scannedWorktreeCount: 0,
    unavailableWorktreeCount: worktreeRows.length,
    repos: repoSummaries,
    worktrees: worktreeRows.sort(
      (a, b) => b.sizeBytes - a.sizeBytes || a.displayName.localeCompare(b.displayName)
    )
  }
}

async function analyzeActiveRuntimeSpace(
  environmentId: string
): Promise<WorkspaceSpaceAnalysis | null> {
  try {
    const response = await callRuntime(
      environmentId,
      'workspaceSpace.analyze',
      null,
      REMOTE_WORKSPACE_SPACE_TIMEOUT_MS
    )
    if (response.ok === true && isWorkspaceSpaceAnalysis(response.result)) {
      return response.result
    }
  } catch {
    // Fall through to inventory-only.
  }
  try {
    return await inventoryRuntimeWorkspaces(environmentId)
  } catch {
    return null
  }
}

export function registerWorkspaceSpaceHandlers(store: Store): void {
  let inFlightScan: InFlightWorkspaceSpaceScan | null = null
  ipcMain.removeHandler('workspaceSpace:cancel')
  ipcMain.removeHandler('workspaceSpace:analyze')
  ipcMain.handle('workspaceSpace:analyze', async (event): Promise<WorkspaceSpaceAnalyzeResult> => {
    const environmentId = store.getSettings()?.activeRuntimeEnvironmentId?.trim()
    if (environmentId) {
      const analysis = await analyzeActiveRuntimeSpace(environmentId)
      if (analysis) {
        return { ok: true, analysis }
      }
    }

    if (!inFlightScan) {
      const controller = new AbortController()
      const scanId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      let latestProgress: WorkspaceSpaceScanProgress = {
        scanId,
        state: 'running',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        totalRepoCount: 0,
        scannedRepoCount: 0,
        totalWorktreeCount: 0,
        scannedWorktreeCount: 0,
        currentRepoDisplayName: null,
        currentWorktreeDisplayName: null
      }
      let lastProgressSentAt = 0
      const sendProgress = (progress: WorkspaceSpaceScanProgress): void => {
        const now = Date.now()
        const isFirstProgress = lastProgressSentAt === 0
        const isTerminalProgress =
          progress.state !== 'running' ||
          (progress.totalWorktreeCount > 0 &&
            progress.scannedWorktreeCount >= progress.totalWorktreeCount)
        if (
          !isFirstProgress &&
          !isTerminalProgress &&
          now - lastProgressSentAt < PROGRESS_EMIT_INTERVAL_MS
        ) {
          return
        }
        lastProgressSentAt = now
        if (!event.sender.isDestroyed()) {
          event.sender.send('workspaceSpace:progress', progress)
        }
      }
      const scan: InFlightWorkspaceSpaceScan = {
        scanId,
        controller,
        progress: latestProgress,
        promise: Promise.resolve(null as never)
      }
      inFlightScan = scan
      scan.promise = analyzeWorkspaceSpace(store, {
        scanId,
        signal: controller.signal,
        onProgress: (progress) => {
          latestProgress = progress
          scan.progress = progress
          sendProgress(progress)
        }
      })
        .then((analysis): WorkspaceSpaceAnalyzeResult => ({ ok: true, analysis }))
        .catch((error: unknown): WorkspaceSpaceAnalyzeResult => {
          if (error instanceof WorkspaceSpaceScanCancelledError) {
            return { ok: false, cancelled: true }
          }
          throw error
        })
        .finally(() => {
          inFlightScan = null
        })
    }
    return inFlightScan.promise
  })

  ipcMain.handle('workspaceSpace:cancel', async (): Promise<boolean> => {
    if (!inFlightScan || inFlightScan.controller.signal.aborted) {
      return false
    }
    inFlightScan.controller.abort()
    inFlightScan.progress = {
      ...inFlightScan.progress,
      state: 'cancelling',
      updatedAt: Date.now()
    }
    return true
  })
}
