import { ipcRenderer } from 'electron'
import type { MemorySnapshot } from '../../shared/process-stats-types'

export const memoryApi = {
  getSnapshot: (): Promise<MemorySnapshot> => ipcRenderer.invoke('memory:getSnapshot')
}
