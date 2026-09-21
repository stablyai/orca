import { ipcRenderer } from 'electron'
import type { AgentTrustPreset } from '../../shared/tui-agent-config'
import type { PreloadApi } from '../api-types'

export const agentTrustApi = {
  markTrusted: (args: {
    preset: AgentTrustPreset
    workspacePath: string
    connectionId?: string
  }): Promise<void> => ipcRenderer.invoke('agentTrust:markTrusted', args)
} satisfies PreloadApi['agentTrust']
