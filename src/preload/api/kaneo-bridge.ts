import { ipcRenderer } from 'electron'
import type { KaneoDesktopApi } from '../../shared/kaneo-types'

export const kaneoApi: KaneoDesktopApi = {
  status: () => ipcRenderer.invoke('kaneo:status'),
  connect: (args) => ipcRenderer.invoke('kaneo:connect', args),
  disconnect: () => ipcRenderer.invoke('kaneo:disconnect'),
  cancelTask: (args) => ipcRenderer.invoke('kaneo:cancelTask', args),
  getTask: (args) => ipcRenderer.invoke('kaneo:getTask', args)
}
