import { ipcRenderer } from 'electron'
import {
  ORCA_CLOUD_SYNC_CHANNELS as CH,
  type CloudSyncApi,
  type CloudSyncView
} from '../../shared/cloud-sync/cloud-sync-contract'

export const cloudSyncApi: CloudSyncApi = {
  getState: (workspaceId) => ipcRenderer.invoke(CH.getState, workspaceId),
  setChoice: (args) => ipcRenderer.invoke(CH.setChoice, args),
  openFolder: (workspaceId) => ipcRenderer.invoke(CH.openFolder, workspaceId),
  retry: (workspaceId) => ipcRenderer.invoke(CH.retry, workspaceId),
  removalPreview: (workspaceId) => ipcRenderer.invoke(CH.removalPreview, workspaceId),
  onChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, view: CloudSyncView) => listener(view)
    ipcRenderer.on(CH.changed, handler)
    return () => ipcRenderer.removeListener(CH.changed, handler)
  }
}
