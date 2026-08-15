import { dialog, ipcMain, shell } from 'electron'
import type { KimiAccountService } from '../kimi-accounts/service'
import type { RateLimitService } from '../rate-limits/service'

function isBoundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !value.includes('\u0000') &&
    !/[\r\n]/.test(value)
  )
}

export function registerKimiAccountHandlers(
  kimiAccounts: KimiAccountService,
  rateLimits: RateLimitService
): void {
  ipcMain.handle('kimiAccounts:list', () => kimiAccounts.listAccounts())
  ipcMain.handle('kimiAccounts:login', async (_event, args: { label?: unknown }) => {
    if (!isBoundedText(args?.label, 120)) {
      throw new Error('A Kimi account label is required.')
    }
    const outgoingAccountId = kimiAccounts.listAccounts().activeAccountId
    const state = await kimiAccounts.addAccountWithLogin(args.label, async (instructions) => {
      let verificationUrl: URL
      try {
        verificationUrl = new URL(instructions.verificationUrl ?? '')
      } catch {
        throw new Error('Kimi returned an invalid verification URL.')
      }
      if (verificationUrl.protocol !== 'https:') {
        throw new Error('Kimi returned an unsafe verification URL.')
      }
      const prompt = await dialog.showMessageBox({
        type: 'info',
        title: 'Sign in to Kimi Code',
        message: 'Complete Kimi Code sign-in in your browser.',
        detail: instructions.message,
        buttons: ['Open browser', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
      if (prompt.response !== 0) {
        return 'cancel'
      }
      await shell.openExternal(verificationUrl.toString())
      return 'continue'
    })
    await rateLimits.refreshForKimiAccountChange(outgoingAccountId)
    return state
  })
  ipcMain.handle('kimiAccounts:import', async (_event, args: { label?: unknown }) => {
    if (!isBoundedText(args?.label, 120)) {
      throw new Error('A Kimi account label is required.')
    }
    const selection = await dialog.showOpenDialog({
      title: 'Select an existing Kimi Code home',
      properties: ['openDirectory']
    })
    const sourceHome = selection.filePaths[0]
    if (selection.canceled || !sourceHome) {
      throw new Error('Kimi account import was cancelled.')
    }
    const outgoingAccountId = kimiAccounts.listAccounts().activeAccountId
    const state = await kimiAccounts.addAccountFromHome(sourceHome, args.label)
    await rateLimits.refreshForKimiAccountChange(outgoingAccountId)
    return state
  })
  ipcMain.handle('kimiAccounts:select', async (_event, args: { accountId?: unknown }) => {
    if (args?.accountId !== null && !isBoundedText(args?.accountId, 256)) {
      throw new Error('Invalid Kimi account ID.')
    }
    const outgoingAccountId = kimiAccounts.listAccounts().activeAccountId
    const state = await kimiAccounts.selectAccount(args.accountId)
    await rateLimits.refreshForKimiAccountChange(outgoingAccountId)
    return state
  })
  ipcMain.handle(
    'kimiAccounts:rename',
    (_event, args: { accountId?: unknown; label?: unknown }) => {
      if (!isBoundedText(args?.accountId, 256) || !isBoundedText(args?.label, 120)) {
        throw new Error('A Kimi account ID and label are required.')
      }
      return kimiAccounts.renameAccount(args.accountId, args.label)
    }
  )
  ipcMain.handle('kimiAccounts:remove', async (_event, args: { accountId?: unknown }) => {
    if (!isBoundedText(args?.accountId, 256)) {
      throw new Error('A Kimi account ID is required.')
    }
    const outgoingAccountId = kimiAccounts.listAccounts().activeAccountId
    const state = await kimiAccounts.removeAccount(args.accountId)
    rateLimits.evictInactiveKimiCache(args.accountId)
    if (outgoingAccountId === args.accountId) {
      await rateLimits.refreshForKimiAccountChange(outgoingAccountId)
    }
    return state
  })
}
