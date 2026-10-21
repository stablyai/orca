import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const appBackgroundApi = {
  pick: () => ipcRenderer.invoke('appBackground:pick'),
  read: (args) => ipcRenderer.invoke('appBackground:read', args),
  commit: (args) => ipcRenderer.invoke('appBackground:commit', args),
  discard: (stagingId) => ipcRenderer.invoke('appBackground:discard', stagingId)
} satisfies PreloadApi['appBackground']
