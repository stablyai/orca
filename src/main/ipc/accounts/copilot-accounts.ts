import { ipcMain } from 'electron'
import type { CopilotAccountStatus } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import { readCopilotCliAccount } from '../../rate-limits/providers/copilot/copilot-cli-user-cache'

export function registerCopilotAccountHandlers(): void {
  ipcMain.handle('copilotAccounts:getStatus', async (): Promise<CopilotAccountStatus> => {
    try {
      return { ...(await readCopilotCliAccount()), error: null }
    } catch (error) {
      return {
        signedIn: false,
        login: null,
        planType: null,
        error: error instanceof Error ? error.message : 'Unable to read Copilot sign-in'
      }
    }
  })
}
