import { ipcMain } from 'electron'
import type { AntigravityAccountAddTarget, AntigravityAccountService } from '../antigravity-accounts/service'
import type { AntigravityAccountSelectionTarget } from '../antigravity-accounts/runtime-selection'

export function registerAntigravityAccountHandlers(antigravityAccounts: AntigravityAccountService): void {
  ipcMain.handle('antigravityAccounts:list', () => antigravityAccounts.listAccounts())
  ipcMain.handle('antigravityAccounts:add', (_event, args?: AntigravityAccountAddTarget) =>
    antigravityAccounts.addAccount(args)
  )
  ipcMain.handle('antigravityAccounts:reauthenticate', (_event, args: { accountId: string }) =>
    antigravityAccounts.reauthenticateAccount(args.accountId)
  )
  ipcMain.handle('antigravityAccounts:remove', (_event, args: { accountId: string }) =>
    antigravityAccounts.removeAccount(args.accountId)
  )
  ipcMain.handle(
    'antigravityAccounts:select',
    (_event, args: { accountId: string | null } & AntigravityAccountSelectionTarget) =>
      antigravityAccounts.selectAccount(args.accountId, args)
  )
}
