import { ipcRenderer } from 'electron'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import type { PreloadApi } from '../api-types'

export const agentHooksApi = {
  installStatuses: (): Promise<AgentHookInstallStatus[]> =>
    ipcRenderer.invoke('agentHooks:installStatuses')
} satisfies PreloadApi['agentHooks']
