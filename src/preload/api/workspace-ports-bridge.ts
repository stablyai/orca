import { ipcRenderer } from 'electron'
import type { WorkspacePortAdvertisedUrlChangedEvent } from '../../shared/workspace-ports'
import type { PreloadApi } from '../api-types'

export const workspacePortsApi = {
  scan: (args) => ipcRenderer.invoke('workspacePorts:scan', args),
  kill: (args) => ipcRenderer.invoke('workspacePorts:kill', args),
  onAdvertisedUrlChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      event: WorkspacePortAdvertisedUrlChangedEvent
    ): void => callback(event)
    ipcRenderer.on('workspacePorts:advertised-url-changed', listener)
    return () => ipcRenderer.removeListener('workspacePorts:advertised-url-changed', listener)
  }
} satisfies PreloadApi['workspacePorts']
