import { ipcMain } from 'electron'
import { getGrokAccountStatus } from '../grok-accounts/status'
import {
  addGrokAccount,
  cancelGrokAccountLogin,
  listGrokAccounts,
  selectGrokAccount
} from '../grok-accounts/service'
import type { RateLimitService } from '../rate-limits/service'

export function registerGrokAccountHandlers(rateLimits?: RateLimitService): void {
  ipcMain.handle('grokAccounts:getStatus', () => getGrokAccountStatus())
  ipcMain.handle('grokAccounts:list', () => listGrokAccounts())
  const add = async (accountId?: string): Promise<Awaited<ReturnType<typeof addGrokAccount>>> => {
    const state = await addGrokAccount(accountId)
    void rateLimits?.refreshForGrokAccountChange().catch(() => {})
    return state
  }
  ipcMain.handle('grokAccounts:add', () => add())
  ipcMain.handle('grokAccounts:reauthenticate', (_event, args: { accountId: unknown }) => {
    if (typeof args?.accountId !== 'string') {
      throw new Error('Invalid Grok account')
    }
    return add(args.accountId)
  })
  ipcMain.handle('grokAccounts:cancelLogin', () => cancelGrokAccountLogin())
  ipcMain.handle('grokAccounts:select', async (_event, args: { accountId: unknown }) => {
    if (args?.accountId !== null && typeof args?.accountId !== 'string') {
      throw new Error('Invalid Grok account')
    }
    const state = await selectGrokAccount(args.accountId, () => {
      void rateLimits?.refreshForGrokAccountChange().catch(() => {})
    })
    return state
  })
}
