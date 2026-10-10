import type {
  WorkspaceCleanupDismissArgs,
  WorkspaceCleanupScanArgs,
  WorkspaceCleanupScanProgress,
  WorkspaceCleanupScanResult,
  WorkspaceCleanupSnapshotPruneBatchArgs,
  WorkspaceCleanupSnapshotPruneRecordArgs
} from '../../shared/workspace-cleanup'
import type {
  WorkspaceCleanupTrashStrayDirectoryArgs,
  WorkspaceCleanupTrashStrayDirectoryResult
} from '../../shared/workspace-cleanup-stray-directories'
import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceAnalyzeResult,
  WorkspaceSpaceScanProgress
} from '../../shared/workspace-space-types'

export type WorkspaceCleanupApi = {
  scan: (
    args?: WorkspaceCleanupScanArgs,
    onProgress?: (progress: WorkspaceCleanupScanProgress) => void
  ) => Promise<WorkspaceCleanupScanResult>
  cancelScan?: (scanId: string) => Promise<boolean>
  /** Last persisted broad-scan snapshot; null until one completes or when the cache is stale/corrupt. */
  getCachedScan: () => Promise<WorkspaceCleanupScanResult | null>
  dismiss: (args: WorkspaceCleanupDismissArgs) => Promise<void>
  clearDismissals: () => Promise<void>
  beginRemovalSnapshotPruneBatch?: (args: WorkspaceCleanupSnapshotPruneBatchArgs) => Promise<void>
  recordRemovalSnapshotPrune?: (args: WorkspaceCleanupSnapshotPruneRecordArgs) => Promise<void>
  finishRemovalSnapshotPruneBatch?: (args: WorkspaceCleanupSnapshotPruneBatchArgs) => Promise<void>
  /** Moves an unregistered folder from a worktree root to the OS trash after re-checking it. */
  trashStrayDirectory?: (
    args: WorkspaceCleanupTrashStrayDirectoryArgs
  ) => Promise<WorkspaceCleanupTrashStrayDirectoryResult>
}

export type WorkspaceSpaceApi = {
  analyze: () => Promise<WorkspaceSpaceAnalyzeResult>
  /** Last persisted analysis (topLevelItems pruned to bound the payload); null until one completes. */
  getCachedAnalysis: () => Promise<WorkspaceSpaceAnalysis | null>
  cancel: () => Promise<boolean>
  onProgress: (callback: (progress: WorkspaceSpaceScanProgress) => void) => () => void
}
