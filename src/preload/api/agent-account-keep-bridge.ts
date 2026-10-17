import { ipcRenderer } from 'electron'
import type { SetAgentKeptRequest, SetAgentKeptResult } from '../../shared/agent-run-account'
import type { PreloadApi } from '../api-types'

export const agentAccountKeepApi = {
  setKept: (args: SetAgentKeptRequest): Promise<SetAgentKeptResult> =>
    ipcRenderer.invoke('agentAccounts:setKept', args)
} satisfies PreloadApi['agentAccounts']
