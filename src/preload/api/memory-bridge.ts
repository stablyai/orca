import { ipcRenderer } from 'electron'
import type { MemorySnapshot } from '../../shared/process-stats-types'
import type { PreloadApi } from '../api-types'

export const memoryApi = {
  getSnapshot: (): Promise<MemorySnapshot> => ipcRenderer.invoke('memory:getSnapshot')
} satisfies PreloadApi['memory']
