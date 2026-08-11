import { ipcMain } from 'electron'
import type {
  MuseSparkAccountSelectionTarget,
  MuseSparkAccountService
} from '../muse-spark-accounts/service'

export function registerMuseSparkAccountHandlers(museSparkAccounts: MuseSparkAccountService): void {
  ipcMain.handle('museSparkAccounts:list', () => museSparkAccounts.listAccounts())
  ipcMain.handle('museSparkAccounts:add', () => museSparkAccounts.addAccount())
  ipcMain.handle('museSparkAccounts:remove', (_event, args: { accountId: string }) =>
    museSparkAccounts.removeAccount(args.accountId)
  )
  ipcMain.handle(
    'museSparkAccounts:select',
    (_event, args: { accountId: string | null } & Partial<MuseSparkAccountSelectionTarget>) => {
      if (!args.runtime) {
        return museSparkAccounts.selectAccount(args.accountId)
      }
      return museSparkAccounts.selectAccountForTarget(args.accountId, {
        runtime: args.runtime,
        wslDistro: args.wslDistro ?? null
      })
    }
  )
}
