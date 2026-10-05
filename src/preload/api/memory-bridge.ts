import { ipcRenderer } from 'electron'
import type { MemorySnapshot } from '../../shared/process-stats-types'
import type { PreloadApi } from '../api-types'

export const memoryApi = {
  // Why: omitted/local executionHostId keeps the local collector; a runtime host id
  // proxies diagnostics.memory to that machine.
  getSnapshot: (request?: { executionHostId?: string | null }): Promise<MemorySnapshot> =>
    ipcRenderer.invoke('memory:getSnapshot', request)
} satisfies PreloadApi['memory']
