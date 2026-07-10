import { ipcMain } from 'electron'
import type { GrokAccountService } from '../grok-accounts/service'

function requireAccountId(args: unknown): string {
  if (
    !args ||
    typeof args !== 'object' ||
    typeof (args as { accountId?: unknown }).accountId !== 'string'
  ) {
    throw new Error('Invalid Grok account id.')
  }
  return (args as { accountId: string }).accountId
}

function requireSelectableAccountId(args: unknown): string | null {
  if (
    args &&
    typeof args === 'object' &&
    ((args as { accountId?: unknown }).accountId === null ||
      typeof (args as { accountId?: unknown }).accountId === 'string')
  ) {
    return (args as { accountId: string | null }).accountId
  }
  throw new Error('Invalid Grok account id.')
}

export function registerGrokAccountHandlers(grokAccounts: GrokAccountService): void {
  ipcMain.handle('grokAccounts:list', () => grokAccounts.listAccounts())
  ipcMain.handle('grokAccounts:add', () => grokAccounts.addAccount())
  ipcMain.handle('grokAccounts:reauthenticate', (_event, args: unknown) =>
    grokAccounts.reauthenticateAccount(requireAccountId(args))
  )
  ipcMain.handle('grokAccounts:remove', (_event, args: unknown) =>
    grokAccounts.removeAccount(requireAccountId(args))
  )
  ipcMain.handle('grokAccounts:select', (_event, args: unknown) =>
    grokAccounts.selectAccount(requireSelectableAccountId(args))
  )
}
