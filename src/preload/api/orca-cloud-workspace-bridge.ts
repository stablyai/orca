import { ipcRenderer } from 'electron'
import {
  ORCA_CLOUD_WORKSPACE_CHANNELS as CH,
  type CloudOomEvent,
  type CloudWakeProgressEvent,
  type OrcaCloudWorkspaceApi
} from '../../shared/hosted-sandbox/cloud-workspace-api'

export const orcaCloudWorkspaceApi = {
  getStatus: (args) => ipcRenderer.invoke(CH.getStatus, args),
  restart: (args) => ipcRenderer.invoke(CH.restart, args),
  archive: (args) => ipcRenderer.invoke(CH.archive, args),
  unarchive: (args) => ipcRenderer.invoke(CH.unarchive, args),
  getArchive: (args) => ipcRenderer.invoke(CH.getArchive, args),
  listCloudWorkspaceIds: () => ipcRenderer.invoke(CH.listCloudWorkspaceIds),
  onWakeProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: CloudWakeProgressEvent): void =>
      callback(event)
    ipcRenderer.on(CH.wakeProgress, listener)
    return () => ipcRenderer.removeListener(CH.wakeProgress, listener)
  },
  onOom: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: CloudOomEvent): void =>
      callback(event)
    ipcRenderer.on(CH.oom, listener)
    return () => ipcRenderer.removeListener(CH.oom, listener)
  }
} satisfies OrcaCloudWorkspaceApi
