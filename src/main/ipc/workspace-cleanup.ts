import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import {
  WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
  type WorkspaceCleanupDismissArgs,
  type WorkspaceCleanupScanArgs,
  type WorkspaceCleanupScanResult,
  type WorkspaceCleanupSnapshotPruneBatchArgs,
  type WorkspaceCleanupSnapshotPruneRecordArgs
} from '../../shared/workspace-cleanup'
import { parseExecutionHostId } from '../../shared/execution-host'
import { getWorkspaceCleanupHostIdentity } from '../../shared/workspace-cleanup-host-identity'
import { scanWorkspaceCleanup } from './workspace-cleanup-scan'
import { hasTargetedWorkspaceCleanupScan } from './workspace-cleanup-scan-targets'
import {
  persistWorkspaceCleanupScanResult,
  readWorkspaceCleanupScanSnapshot
} from '../workspace-cleanup-scan-snapshot'
import {
  beginWorkspaceCleanupRemovalSnapshotPruneBatch,
  finishWorkspaceCleanupRemovalSnapshotPruneBatch,
  recordWorkspaceCleanupRemovalSnapshotPrune
} from '../workspace-cleanup-removal-snapshot-prune'

export { scanWorkspaceCleanup }

// Why: module scope — handler re-registration on a new main window must not
// orphan the previous window's controllers in a discarded map.
const activeScans = new Map<string, AbortController>()
// Keyed by sender AND scan mode: legacy suggestion-only and full-workspace
// broad scans are separate lanes and must not supersede each other, matching
// the renderer's broad-scan registry.
const broadScanControllersBySenderMode = new Map<string, AbortController>()

function getBroadScanModeKey(senderId: number, args: WorkspaceCleanupScanArgs): string {
  return `${senderId}\0${args.includeAllWorkspaces === true}`
}

export function registerWorkspaceCleanupHandlers(store: Store): void {
  const snapshotDirectory = store.getProfileStorageDirectory()
  ipcMain.removeHandler('workspaceCleanup:scan')
  ipcMain.removeHandler('workspaceCleanup:cancelScan')
  ipcMain.removeHandler('workspaceCleanup:getCachedScan')
  ipcMain.removeHandler('workspaceCleanup:dismiss')
  ipcMain.removeHandler('workspaceCleanup:clearDismissals')
  ipcMain.removeHandler('workspaceCleanup:beginRemovalSnapshotPruneBatch')
  ipcMain.removeHandler('workspaceCleanup:recordRemovalSnapshotPrune')
  ipcMain.removeHandler('workspaceCleanup:finishRemovalSnapshotPruneBatch')

  ipcMain.handle(
    'workspaceCleanup:scan',
    async (event, args?: WorkspaceCleanupScanArgs): Promise<WorkspaceCleanupScanResult> => {
      const scanArgs = args ?? {}
      const sender = event.sender
      const scanKey = getWorkspaceCleanupScanKey(sender.id, scanArgs.scanId)
      const controller = new AbortController()
      if (scanKey) {
        activeScans.set(scanKey, controller)
      }
      const targeted = hasTargetedWorkspaceCleanupScan(scanArgs)
      const broadScanKey = getBroadScanModeKey(sender.id, scanArgs)
      if (!targeted) {
        // Why: two same-mode broad fleet scans from one renderer can only be a
        // refresh race; running both doubles git subprocess and fs load for a
        // result the renderer will discard.
        broadScanControllersBySenderMode.get(broadScanKey)?.abort()
        broadScanControllersBySenderMode.set(broadScanKey, controller)
      }
      // Why: a window close or reload must stop the fleet scan's git and fs
      // work, not merely mute its progress events.
      const onSenderDestroyed = (): void => controller.abort()
      sender.once('destroyed', onSenderDestroyed)
      try {
        const result = await scanWorkspaceCleanup(store, scanArgs, {
          signal: controller.signal,
          onProgress: scanArgs.scanId
            ? (progress) => {
                if (!sender.isDestroyed()) {
                  sender.send('workspaceCleanup:scanProgress', progress)
                }
              }
            : undefined
        })
        // Focused scans are live-only; persisting each rewrites and fsyncs the
        // fleet snapshot. worktreeIds: [] is still targeted — persisting its
        // empty result would wipe the fleet cache.
        if (!targeted) {
          void persistWorkspaceCleanupScanResult(snapshotDirectory, scanArgs, result)
        }
        return result
      } finally {
        if (!sender.isDestroyed()) {
          sender.removeListener('destroyed', onSenderDestroyed)
        }
        if (scanKey && activeScans.get(scanKey) === controller) {
          activeScans.delete(scanKey)
        }
        if (!targeted && broadScanControllersBySenderMode.get(broadScanKey) === controller) {
          broadScanControllersBySenderMode.delete(broadScanKey)
        }
      }
    }
  )

  ipcMain.handle('workspaceCleanup:cancelScan', (event, scanId: string): boolean => {
    const scanKey = getWorkspaceCleanupScanKey(event.sender.id, scanId)
    const controller = scanKey ? activeScans.get(scanKey) : undefined
    if (!controller || controller.signal.aborted) {
      return false
    }
    controller.abort()
    return true
  })

  ipcMain.handle('workspaceCleanup:getCachedScan', (): Promise<WorkspaceCleanupScanResult | null> =>
    readWorkspaceCleanupScanSnapshot(snapshotDirectory)
  )

  ipcMain.handle('workspaceCleanup:dismiss', (_event, args: WorkspaceCleanupDismissArgs) => {
    const next = { ...store.getUI().workspaceCleanup?.dismissals }
    for (const worktreeId of args.removedWorktreeIds ?? []) {
      for (const [identity, dismissal] of Object.entries(next)) {
        if (dismissal.worktreeId === worktreeId) {
          delete next[identity]
        }
      }
    }
    for (const dismissal of args.dismissals ?? []) {
      if (
        dismissal &&
        dismissal.classifierVersion === WORKSPACE_CLEANUP_CLASSIFIER_VERSION &&
        typeof dismissal.worktreeId === 'string' &&
        typeof dismissal.fingerprint === 'string' &&
        (dismissal.executionHostId === undefined || parseExecutionHostId(dismissal.executionHostId))
      ) {
        const identity = dismissal.executionHostId
          ? getWorkspaceCleanupHostIdentity(dismissal.executionHostId, dismissal.worktreeId)
          : dismissal.worktreeId
        next[identity] = dismissal
      }
    }
    store.updateUI({ workspaceCleanup: { dismissals: next } })
  })

  ipcMain.handle('workspaceCleanup:clearDismissals', () => {
    store.updateUI({ workspaceCleanup: { dismissals: {} } })
  })

  ipcMain.handle(
    'workspaceCleanup:beginRemovalSnapshotPruneBatch',
    (_event, args: WorkspaceCleanupSnapshotPruneBatchArgs) => {
      if (isSnapshotPruneBatchId(args?.batchId)) {
        beginWorkspaceCleanupRemovalSnapshotPruneBatch(snapshotDirectory, args)
      }
    }
  )

  ipcMain.handle(
    'workspaceCleanup:recordRemovalSnapshotPrune',
    (_event, args: WorkspaceCleanupSnapshotPruneRecordArgs) => {
      if (
        isSnapshotPruneBatchId(args?.batchId) &&
        typeof args?.worktreeId === 'string' &&
        args.worktreeId.length > 0 &&
        (args.executionHostId === undefined || parseExecutionHostId(args.executionHostId))
      ) {
        recordWorkspaceCleanupRemovalSnapshotPrune(snapshotDirectory, args)
      }
    }
  )

  ipcMain.handle(
    'workspaceCleanup:finishRemovalSnapshotPruneBatch',
    (_event, args: WorkspaceCleanupSnapshotPruneBatchArgs) => {
      if (isSnapshotPruneBatchId(args?.batchId)) {
        return finishWorkspaceCleanupRemovalSnapshotPruneBatch(snapshotDirectory, args)
      }
      return undefined
    }
  )
}

function isSnapshotPruneBatchId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function getWorkspaceCleanupScanKey(senderId: number, scanId: unknown): string | null {
  return typeof scanId === 'string' && scanId.length > 0 && scanId.length <= 128
    ? `${senderId}\0${scanId}`
    : null
}
