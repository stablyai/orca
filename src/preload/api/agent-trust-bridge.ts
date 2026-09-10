import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { AgentTrustPreset } from '../../shared/agent-trust-preset'

export const agentTrustApi = {
  markTrusted: (args: {
    preset: AgentTrustPreset
    workspacePath: string
    connectionId?: string
  }): Promise<void> => ipcRenderer.invoke('agentTrust:markTrusted', args)
} satisfies PreloadApi['agentTrust']
