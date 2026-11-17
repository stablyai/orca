import { ipcRenderer } from 'electron'
import {
  ORCA_CLOUD_OFFLINE_CHANNELS as CH,
  type CloudWorkspaceOfflineApi
} from '../../shared/hosted-sandbox/cloud-workspace-offline-api'

export const orcaCloudOfflineApi = {
  getSnapshot: (args) => ipcRenderer.invoke(CH.getSnapshot, args),
  queuePrompt: (args) => ipcRenderer.invoke(CH.queuePrompt, args),
  listQueuedPrompts: (args) => ipcRenderer.invoke(CH.listQueuedPrompts, args),
  cancelQueuedPrompt: (args) => ipcRenderer.invoke(CH.cancelQueuedPrompt, args),
  editQueuedPrompt: (args) => ipcRenderer.invoke(CH.editQueuedPrompt, args),
  onQueuedPromptsChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: { workspaceId: string }): void =>
      callback(event)
    ipcRenderer.on(CH.queuedPromptsChanged, listener)
    return () => ipcRenderer.removeListener(CH.queuedPromptsChanged, listener)
  }
} satisfies CloudWorkspaceOfflineApi
