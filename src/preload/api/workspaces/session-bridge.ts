import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../../api-types'

export const sessionApi = {
  get: (hostId) => ipcRenderer.invoke('session:get', hostId),
  listHostIds: () => ipcRenderer.invoke('session:list-host-ids'),
  set: (args, hostId) => ipcRenderer.invoke('session:set', args, hostId),
  patch: (args, hostId) => ipcRenderer.invoke('session:patch', args, hostId),
  pruneClosedOpenFile: (args) => ipcRenderer.invoke('session:prune-closed-open-file', args),
  closeTerminalSurface: (args) => ipcRenderer.invoke('session:close-terminal-surface', args),
  flush: () => ipcRenderer.invoke('session:flush'),
  readTerminalScrollback: (args) => ipcRenderer.invoke('session:read-terminal-scrollback', args)
} satisfies PreloadApi['session']
