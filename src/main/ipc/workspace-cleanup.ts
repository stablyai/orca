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
import { abortWhenRendererGone } from './renderer-lifetime-abort'
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

// Module scope preserves old-window scan cancellation across handler re-registration.
const activeScans = new Map<string, AbortController>()
// Separate legacy/full-list lanes by sender and mode, matching renderer scan ownership.
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
        // Same-sender, same-mode refreshes supersede expensive work whose result would be discarded.
        broadScanControllersBySenderMode.get(broadScanKey)?.abort()
        broadScanControllersBySenderMode.set(broadScanKey, controller)
      }
      // Window retirement must cancel scan work, not merely mute its progress.
      const lifetime = abortWhenRendererGone(sender)
      lifetime.signal.addEventListener('abort', () => controller.abort(), { once: true })
      try {
        const result = await scanWorkspaceCleanup(store, scanArgs, {
          signal: controller.signal,
          onProgress: scanArgs.scanId
            ? (progress) => {
                if (!controller.signal.aborted && !sender.isDestroyed()) {
                  sender.send('workspaceCleanup:scanProgress', progress)
                }
              }
            : undefined
        })
        // Persist only fleet scans: even empty targeted results would wipe the broad snapshot.
        if (!targeted) {
          void persistWorkspaceCleanupScanResult(snapshotDirectory, scanArgs, result)
        }
        return result
      } finally {
        lifetime.dispose()
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
