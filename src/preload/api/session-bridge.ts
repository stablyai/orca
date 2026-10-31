import type { WorkspacePresentationDelta } from '../../shared/workspace-presentation'
import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const sessionApi = {
  onPresentationsChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, delta: WorkspacePresentationDelta) =>
      callback(delta)
    ipcRenderer.on('session:presentations-changed', listener)
    return () => ipcRenderer.removeListener('session:presentations-changed', listener)
  },
  getPresentations: () => ipcRenderer.invoke('session:get-presentations'),
  commitPresentation: (args) => ipcRenderer.invoke('session:commit-presentation', args),
  get: (hostId) => ipcRenderer.invoke('session:get', hostId),
  listHostIds: () => ipcRenderer.invoke('session:list-host-ids'),
  set: (args, hostId) => ipcRenderer.invoke('session:set', args, hostId),
  patch: (args, hostId) => ipcRenderer.invoke('session:patch', args, hostId),
  closeTerminalSurface: (args) => ipcRenderer.invoke('session:close-terminal-surface', args),
  flush: () => ipcRenderer.invoke('session:flush'),
  readTerminalScrollback: (args) =>
    ipcRenderer.sendSync('session:read-terminal-scrollback-sync', args),
  hasTerminalScrollback: (args) =>
    ipcRenderer.sendSync('session:has-terminal-scrollback-sync', args)
} satisfies PreloadApi['session']
