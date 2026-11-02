import { ipcRenderer } from 'electron'
import type { MemorySnapshot } from '../../shared/process-stats-types'
import type { PreloadApi } from '../api-types'

import type { ResourceViewAdmission } from '../../shared/resource-view-admission'

export const memoryApi = {
  getSnapshot: (admission?: ResourceViewAdmission): Promise<MemorySnapshot> =>
    ipcRenderer.invoke('memory:getSnapshot', admission),
  resourceWindowVisible: (): Promise<boolean> => ipcRenderer.invoke('memory:resourceWindowVisible'),
  onResourceWindowVisibility: (callback: (visible: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, visible: boolean): void =>
      callback(visible)
    ipcRenderer.on('memory:resourceWindowVisibility', listener)
    return () => ipcRenderer.removeListener('memory:resourceWindowVisibility', listener)
  }
} satisfies PreloadApi['memory']
