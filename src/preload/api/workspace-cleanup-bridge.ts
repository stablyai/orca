import { ipcRenderer } from 'electron'
import type { WorkspaceCleanupScanProgress } from '../../shared/workspace-cleanup'
import type { PreloadApi } from '../api-types'

export const workspaceCleanupApi = {
  scan: (args, onProgress) => {
    if (!onProgress) {
      return ipcRenderer.invoke('workspaceCleanup:scan', args)
    }
    const scanId = args?.scanId ?? crypto.randomUUID()
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: WorkspaceCleanupScanProgress
    ): void => {
      if (progress.scanId === scanId) {
        onProgress(progress)
      }
    }
    ipcRenderer.on('workspaceCleanup:scanProgress', listener)
    return ipcRenderer
      .invoke('workspaceCleanup:scan', { ...args, scanId })
      .finally(() => ipcRenderer.removeListener('workspaceCleanup:scanProgress', listener))
  },
  cancelScan: (scanId) => ipcRenderer.invoke('workspaceCleanup:cancelScan', scanId),
  getCachedScan: () => ipcRenderer.invoke('workspaceCleanup:getCachedScan'),
  dismiss: (args) => ipcRenderer.invoke('workspaceCleanup:dismiss', args),
  clearDismissals: () => ipcRenderer.invoke('workspaceCleanup:clearDismissals'),
  beginRemovalSnapshotPruneBatch: (args) =>
    ipcRenderer.invoke('workspaceCleanup:beginRemovalSnapshotPruneBatch', args),
  recordRemovalSnapshotPrune: (args) =>
    ipcRenderer.invoke('workspaceCleanup:recordRemovalSnapshotPrune', args),
  finishRemovalSnapshotPruneBatch: (args) =>
    ipcRenderer.invoke('workspaceCleanup:finishRemovalSnapshotPruneBatch', args)
} satisfies PreloadApi['workspaceCleanup']
