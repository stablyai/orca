import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const agentTrustApi = {
  markTrusted: (args: {
    preset: 'cursor' | 'copilot' | 'codex'
    workspacePath: string
    connectionId?: string
  }): Promise<void> => ipcRenderer.invoke('agentTrust:markTrusted', args)
} satisfies PreloadApi['agentTrust']
