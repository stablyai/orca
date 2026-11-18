import { ipcRenderer } from 'electron'
import type { ZotzAgentQueueSnapshot } from '../../../shared/zotz/agent-queue/zotz-agent-queue-snapshot'
import type { PreloadApi } from '../../api-types'

export const zotzAgentQueueApi = {
  snapshot: () => ipcRenderer.invoke('zotzAgentQueue:snapshot'),
  onChanged: (callback: (snapshot: ZotzAgentQueueSnapshot) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: ZotzAgentQueueSnapshot): void =>
      callback(snapshot)
    ipcRenderer.on('zotzAgentQueue:changed', listener)
    return () => ipcRenderer.removeListener('zotzAgentQueue:changed', listener)
  },
  forceStart: (id: string) => ipcRenderer.invoke('zotzAgentQueue:forceStart', id),
  cancel: (id: string) => ipcRenderer.invoke('zotzAgentQueue:cancel', id),
  dismissCanceled: (id: string) => ipcRenderer.invoke('zotzAgentQueue:dismissCanceled', id)
} satisfies PreloadApi['zotzAgentQueue']
