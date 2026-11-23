import { ipcRenderer } from 'electron'
import type { CopilotAccountStatus } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { PreloadApi } from '../../api-types'

export const copilotAccountsApi = {
  getStatus: (): Promise<CopilotAccountStatus> => ipcRenderer.invoke('copilotAccounts:getStatus')
} satisfies PreloadApi['copilotAccounts']
