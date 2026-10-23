import type {
  WorkspaceCleanupDismissArgs,
  WorkspaceCleanupScanArgs,
  WorkspaceCleanupScanProgress,
  WorkspaceCleanupScanResult,
  WorkspaceCleanupSnapshotPruneBatchArgs,
  WorkspaceCleanupSnapshotPruneRecordArgs
} from '../../shared/workspace-cleanup'
import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceAnalyzeResult,
  WorkspaceSpaceScanProgress
} from '../../shared/workspace-space-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSpaceChange } from '../../shared/workspace-space-change'

export type WorkspaceCleanupApi = {
  scan: (
    args?: WorkspaceCleanupScanArgs,
    onProgress?: (progress: WorkspaceCleanupScanProgress) => void
  ) => Promise<WorkspaceCleanupScanResult>
  cancelScan?: (scanId: string) => Promise<boolean>
  /** Null until a scan completes or when its cache is stale/corrupt. */
  getCachedScan: () => Promise<WorkspaceCleanupScanResult | null>
  dismiss: (args: WorkspaceCleanupDismissArgs) => Promise<void>
  clearDismissals: () => Promise<void>
  beginRemovalSnapshotPruneBatch?: (args: WorkspaceCleanupSnapshotPruneBatchArgs) => Promise<void>
  recordRemovalSnapshotPrune?: (args: WorkspaceCleanupSnapshotPruneRecordArgs) => Promise<void>
  finishRemovalSnapshotPruneBatch?: (args: WorkspaceCleanupSnapshotPruneBatchArgs) => Promise<void>
}

export type WorkspaceSpaceApi = {
  analyze: () => Promise<WorkspaceSpaceAnalyzeResult>
  /** Cached analysis prunes topLevelItems to bound the payload. */
  getCachedAnalysis: () => Promise<WorkspaceSpaceAnalysis | null>
  cancel: () => Promise<boolean>
  onProgress: (callback: (progress: WorkspaceSpaceScanProgress) => void) => () => void
  openWindow?: () => Promise<void>
  closeWindow?: () => Promise<void>
  publishWindowState?: (state: unknown) => Promise<void>
  requestWindowState?: () => Promise<void>
  onWindowStateRequested?: (callback: () => void) => () => void
  onWindowClosed?: (callback: () => void) => () => void
  onWindowState?: (callback: (state: unknown) => void) => () => void
  revealWorktree?: (
    worktreeId: string,
    executionHostId?: ExecutionHostId,
    change?: WorkspaceSpaceChange
  ) => Promise<void>
  onRevealWorktree?: (
    callback: (
      worktreeId: string,
      executionHostId?: ExecutionHostId,
      change?: WorkspaceSpaceChange
    ) => void
  ) => () => void
  requestWorktreeRefresh?: () => Promise<void>
  onWorktreeRefreshRequested?: (callback: () => void) => () => void
  publishWindowAnalysis?: (analysis: WorkspaceSpaceAnalysis) => Promise<void>
  onWindowAnalysis?: (callback: (analysis: WorkspaceSpaceAnalysis) => void) => () => void
}
