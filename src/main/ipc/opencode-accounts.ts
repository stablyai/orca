import { ipcMain } from 'electron'
import type { OpenCodeAccountService } from '../opencode-accounts/service'

export function registerOpenCodeAccountHandlers(openCodeAccounts: OpenCodeAccountService): void {
  ipcMain.handle('openCodeAccounts:list', () => openCodeAccounts.listAccounts())
  ipcMain.handle('openCodeAccounts:add', (_event, args: { label: string; apiKey: string }) =>
    openCodeAccounts.addAccount(args)
  )
  ipcMain.handle(
    'openCodeAccounts:reauthenticate',
    (_event, args: { accountId: string; label: string; apiKey: string }) =>
      openCodeAccounts.reauthenticateAccount(args.accountId, args)
  )
  ipcMain.handle('openCodeAccounts:remove', (_event, args: { accountId: string }) =>
    openCodeAccounts.removeAccount(args.accountId)
  )
  ipcMain.handle('openCodeAccounts:select', (_event, args: { accountId: string | null }) =>
    openCodeAccounts.selectAccount(args.accountId)
  )
}
