import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const sessionApi = {
  get: (hostId) => ipcRenderer.invoke('session:get', hostId),
  listHostIds: () => ipcRenderer.invoke('session:list-host-ids'),
  set: (args, hostId) => ipcRenderer.invoke('session:set', args, hostId),
  patch: (args, hostId) => ipcRenderer.invoke('session:patch', args, hostId),
  patchTerminalTitles: (args, hostId) =>
    ipcRenderer.invoke('session:patch-terminal-titles', args, hostId),
  closeTerminalSurface: (args) => ipcRenderer.invoke('session:close-terminal-surface', args),
  flush: () => ipcRenderer.invoke('session:flush'),
  readTerminalScrollback: (args) =>
    ipcRenderer.sendSync('session:read-terminal-scrollback-sync', args),
  hasTerminalScrollback: (args) =>
    ipcRenderer.sendSync('session:has-terminal-scrollback-sync', args)
} satisfies PreloadApi['session']
