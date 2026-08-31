import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceAnalyzeResult,
  WorkspaceSpaceScanProgress,
  WorkspaceSpaceWorktreeMeasurement
} from '../../shared/workspace-space-types'
import {
  analyzeWorkspaceSpace,
  WorkspaceSpaceScanCancelledError
} from '../workspace-space-analysis'
import {
  persistWorkspaceSpaceAnalysisSnapshot,
  readWorkspaceSpaceAnalysisSnapshot
} from '../workspace-space-analysis-snapshot'

const PROGRESS_EMIT_INTERVAL_MS = 100

type InFlightWorkspaceSpaceScan = {
  scanId: string
  controller: AbortController
  progress: WorkspaceSpaceScanProgress
  promise: Promise<WorkspaceSpaceAnalyzeResult>
}

export function registerWorkspaceSpaceHandlers(store: Store): void {
  const snapshotDirectory = store.getProfileStorageDirectory()
  let inFlightScan: InFlightWorkspaceSpaceScan | null = null
  ipcMain.removeHandler('workspaceSpace:cancel')
  ipcMain.removeHandler('workspaceSpace:analyze')
  ipcMain.removeHandler('workspaceSpace:getCachedAnalysis')
  ipcMain.handle('workspaceSpace:analyze', async (event): Promise<WorkspaceSpaceAnalyzeResult> => {
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
      let pendingMeasurements: WorkspaceSpaceWorktreeMeasurement[] = []
      const sendProgress = (progress: WorkspaceSpaceScanProgress): void => {
        if (progress.completedMeasurements?.length) {
          pendingMeasurements.push(...progress.completedMeasurements)
        }
        // Why: large fleets can report one progress event per worktree; keep
        // the UI responsive without repainting the full Space page for each row.
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
          const completedMeasurements = pendingMeasurements
          pendingMeasurements = []
          event.sender.send('workspaceSpace:progress', {
            ...progress,
            ...(completedMeasurements.length > 0 ? { completedMeasurements } : {})
          })
        }
      }
      // Why: large worktree fleets require real disk traversal; duplicate
      // requests should share that IO instead of starting competing scans.
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
        .then((analysis): WorkspaceSpaceAnalyzeResult => {
          // Fire-and-forget: a ~6-minute cold analysis must survive reload/restart, but
          // persistence must never delay or fail the reply.
          void persistWorkspaceSpaceAnalysisSnapshot(snapshotDirectory, analysis)
          return { ok: true, analysis }
        })
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

  ipcMain.handle('workspaceSpace:getCachedAnalysis', (): Promise<WorkspaceSpaceAnalysis | null> =>
    readWorkspaceSpaceAnalysisSnapshot(snapshotDirectory)
  )

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
