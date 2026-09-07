import type { IpcRenderer } from 'electron'
import type { WorkspaceWindowNativeBridge } from './api/workspace-window-native-api'
const { ipcRenderer } = require('electron') as { ipcRenderer: IpcRenderer }

export const workspaceWindowFileTransfer: WorkspaceWindowNativeBridge['fileTransfer'] = {
  downloadFile: (args) => ipcRenderer.invoke('workspaceWindow:fs:downloadFile', args),
  downloadFolder: (args) => ipcRenderer.invoke('workspaceWindow:fs:downloadFolder', args),
  saveDownloadedFile: (args) => ipcRenderer.invoke('workspaceWindow:fs:saveDownloadedFile', args),
  startDownloadedFile: (args) => ipcRenderer.invoke('workspaceWindow:fs:startDownloadedFile', args),
  appendDownloadedFileChunk: (args) =>
    ipcRenderer.invoke('workspaceWindow:fs:appendDownloadedFileChunk', args),
  finishDownloadedFile: (args) =>
    ipcRenderer.invoke('workspaceWindow:fs:finishDownloadedFile', args),
  cancelDownloadedFile: (args) =>
    ipcRenderer.invoke('workspaceWindow:fs:cancelDownloadedFile', args),
  importExternalPaths: (args) => ipcRenderer.invoke('workspaceWindow:fs:importExternalPaths', args),
  stageExternalPathsForRuntimeUpload: (args) =>
    ipcRenderer.invoke('workspaceWindow:fs:stageExternalPathsForRuntimeUpload', args),
  resolveDroppedPathsForAgent: (args) =>
    ipcRenderer.invoke('workspaceWindow:fs:resolveDroppedPathsForAgent', args)
}
