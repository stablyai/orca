import { ipcMain } from 'electron'
import type { ClaudeAccountService } from '../claude-accounts/service'
import { isTrustedUIRenderer } from './ui'

export function registerConsoleCredentialHandlers(claudeAccounts: ClaudeAccountService): void {
  const runtimeAuth = claudeAccounts.getRuntimeAuth()

  ipcMain.handle('consoleCredentials:setCredential', async (event, apiKey: string) => {
    if (!isTrustedUIRenderer(event.sender)) {
      return { success: false }
    }
    try {
      await runtimeAuth.setConsoleCredential(apiKey)
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('consoleCredentials:getCredential', async (event) => {
    if (!isTrustedUIRenderer(event.sender)) {
      return {}
    }
    try {
      const apiKey = await runtimeAuth.getConsoleCredential()
      return { apiKey }
    } catch (error) {
      return { error: (error as Error).message }
    }
  })

  ipcMain.handle('consoleCredentials:clearCredential', async (event) => {
    if (!isTrustedUIRenderer(event.sender)) {
      return { success: false }
    }
    try {
      await runtimeAuth.clearConsoleCredential()
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })
}
