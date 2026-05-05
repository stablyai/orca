import { ipcMain } from 'electron'
import type { ClaudeAccountService } from '../claude-accounts/service'

export function registerClaudeAccountHandlers(claudeAccounts: ClaudeAccountService): void {
  ipcMain.handle('claudeAccounts:list', () => claudeAccounts.listAccounts())
  ipcMain.handle('claudeAccounts:add', () => claudeAccounts.addAccount())
  ipcMain.handle('claudeAccounts:reauthenticate', (_event, args: { accountId: string }) =>
    claudeAccounts.reauthenticateAccount(args.accountId)
  )
  ipcMain.handle('claudeAccounts:remove', (_event, args: { accountId: string }) =>
    claudeAccounts.removeAccount(args.accountId)
  )
  ipcMain.handle('claudeAccounts:select', (_event, args: { accountId: string | null }) =>
    claudeAccounts.selectAccount(args.accountId)
  )
}
