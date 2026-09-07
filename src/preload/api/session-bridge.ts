import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const sessionApi = {
  // hostId is optional; main defaults it to 'local' so existing omitting call sites keep the local session partition.
  get: (hostId) => ipcRenderer.invoke('session:get', hostId),
  set: (args, hostId) => ipcRenderer.invoke('session:set', args, hostId),
  patch: (args, hostId) => ipcRenderer.invoke('session:patch', args, hostId),
  flush: () => ipcRenderer.invoke('session:flush'),
  readTerminalScrollback: (args) =>
    ipcRenderer.sendSync('session:read-terminal-scrollback-sync', args),
  /** Synchronous session save for beforeunload — blocks until flushed to disk. */
  setSync: (args, hostId) => {
    ipcRenderer.sendSync('session:set-sync', args, hostId)
  }
} satisfies PreloadApi['session']
