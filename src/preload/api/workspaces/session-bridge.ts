import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../../api-types'

export const sessionApi = {
  get: (hostId) => ipcRenderer.invoke('session:get', hostId),
  listHostIds: () => ipcRenderer.invoke('session:list-host-ids'),
  set: (args, hostId, options) => ipcRenderer.invoke('session:set', args, hostId, options),
  patch: (args, hostId) => ipcRenderer.invoke('session:patch', args, hostId),
  patchEntries: (args, hostId, relays) =>
    ipcRenderer.invoke('session:patch-entries', args, hostId, relays),
  desktopRelaysVersion: () => ipcRenderer.invoke('session:desktop-relays-version'),
  applyDesktopRelays: (args) => ipcRenderer.invoke('session:apply-desktop-relays', args),
  pruneClosedOpenFile: (args) => ipcRenderer.invoke('session:prune-closed-open-file', args),
  closeTerminalSurface: (args) => ipcRenderer.invoke('session:close-terminal-surface', args),
  flush: () => ipcRenderer.invoke('session:flush'),
  readTerminalScrollback: (args) => ipcRenderer.invoke('session:read-terminal-scrollback', args)
} satisfies PreloadApi['session']
