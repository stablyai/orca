import { ipcMain } from 'electron'
import type { CodexAccountService } from '../codex-accounts/service'

export function registerCodexAccountHandlers(codexAccounts: CodexAccountService): void {
  ipcMain.handle('codexAccounts:list', () => codexAccounts.listAccounts())
  ipcMain.handle('codexAccounts:add', () => codexAccounts.addAccount())
  ipcMain.handle('codexAccounts:reauthenticate', (_event, args: { accountId: string }) =>
    codexAccounts.reauthenticateAccount(args.accountId)
  )
  ipcMain.handle('codexAccounts:remove', (_event, args: { accountId: string }) =>
    codexAccounts.removeAccount(args.accountId)
  )
  ipcMain.handle('codexAccounts:select', (_event, args: { accountId: string | null }) =>
    codexAccounts.selectAccount(args.accountId)
  )
}
