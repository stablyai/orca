import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../../api-types'
import type { CommandCodeCredentialsStatus } from '../../../shared/agent-accounts/usage-credentials/command-code-credentials'

export const commandCodeCredentialsApi = {
  getStatus: (): Promise<CommandCodeCredentialsStatus> =>
    ipcRenderer.invoke('commandCodeCredentials:getStatus'),
  saveApiKey: (key: string): Promise<CommandCodeCredentialsStatus> =>
    ipcRenderer.invoke('commandCodeCredentials:saveApiKey', key),
  clearApiKey: (): Promise<CommandCodeCredentialsStatus> =>
    ipcRenderer.invoke('commandCodeCredentials:clearApiKey')
} satisfies PreloadApi['commandCodeCredentials']
