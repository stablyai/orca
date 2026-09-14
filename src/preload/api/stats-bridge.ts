import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const statsApi = {
  getSummary: (): Promise<{
    totalAgentsSpawned: number
    totalPRsCreated: number
    totalAgentTimeMs: number
    firstEventAt: number | null
  }> => ipcRenderer.invoke('stats:summary')
} satisfies PreloadApi['stats']
