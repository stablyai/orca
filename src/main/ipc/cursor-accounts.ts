import { ipcMain } from 'electron'
import type { CursorAccountSelectionTarget, CursorAccountService } from '../cursor-accounts/service'

export function registerCursorAccountHandlers(cursorAccounts: CursorAccountService): void {
  ipcMain.handle('cursorAccounts:list', () => cursorAccounts.listAccounts())
  ipcMain.handle('cursorAccounts:add', () => cursorAccounts.addAccount())
  ipcMain.handle('cursorAccounts:remove', (_event, args: { accountId: string }) =>
    cursorAccounts.removeAccount(args.accountId)
  )
  ipcMain.handle(
    'cursorAccounts:select',
    (_event, args: { accountId: string | null } & Partial<CursorAccountSelectionTarget>) => {
      if (!args.runtime) {
        return cursorAccounts.selectAccount(args.accountId)
      }
      return cursorAccounts.selectAccountForTarget(args.accountId, {
        runtime: args.runtime,
        wslDistro: args.wslDistro ?? null
      })
    }
  )
}
