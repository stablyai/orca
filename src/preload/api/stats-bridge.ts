import { ipcRenderer } from 'electron'

export const statsApi = {
  getSummary: (): Promise<{
    totalAgentsSpawned: number
    totalPRsCreated: number
    totalAgentTimeMs: number
    firstEventAt: number | null
  }> => ipcRenderer.invoke('stats:summary')
}
