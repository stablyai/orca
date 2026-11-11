import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type {
  ToknConnectResult,
  ToknSyncStatus,
  ToknUploadPreview
} from '../../shared/tokn-sync-status'

export const toknApi = {
  getStatus: (): Promise<ToknSyncStatus> => ipcRenderer.invoke('tokn:getStatus'),
  connect: (): Promise<ToknConnectResult> => ipcRenderer.invoke('tokn:connect'),
  cancelConnect: (): Promise<ToknSyncStatus> => ipcRenderer.invoke('tokn:cancelConnect'),
  disconnect: (): Promise<ToknSyncStatus> => ipcRenderer.invoke('tokn:disconnect'),
  syncNow: (): Promise<ToknSyncStatus> => ipcRenderer.invoke('tokn:syncNow'),
  previewUpload: (): Promise<ToknUploadPreview> => ipcRenderer.invoke('tokn:previewUpload')
} satisfies PreloadApi['tokn']
