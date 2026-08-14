import { dialog, ipcMain } from 'electron'
import type { ManagedCliHomeAccountService } from '../provider-managed-homes/service'
import { isBoundedText } from './bounded-account-text'

export function registerManagedProviderHomeHandlers(
  channelPrefix: 'grokAccounts' | 'geminiAccounts',
  service: ManagedCliHomeAccountService,
  displayName: string
): void {
  ipcMain.handle(`${channelPrefix}:list`, () => service.listAccounts())
  ipcMain.handle(`${channelPrefix}:import`, async (_event, args: { label?: unknown }) => {
    if (!isBoundedText(args?.label, 120)) {
      throw new Error(`A ${displayName} account label is required.`)
    }
    const selection = await dialog.showOpenDialog({
      title: `Select an existing ${displayName} CLI home`,
      properties: ['openDirectory']
    })
    const sourceHome = selection.filePaths[0]
    if (selection.canceled || !sourceHome) {
      throw new Error(`${displayName} account import was cancelled.`)
    }
    return service.addAccountFromHome(sourceHome, args.label)
  })
  ipcMain.handle(`${channelPrefix}:select`, (_event, args: { accountId?: unknown }) => {
    if (args?.accountId !== null && !isBoundedText(args?.accountId, 256)) {
      throw new Error(`Invalid ${displayName} account ID.`)
    }
    return service.selectAccount(args.accountId)
  })
  ipcMain.handle(
    `${channelPrefix}:rename`,
    (_event, args: { accountId?: unknown; label?: unknown }) => {
      if (!isBoundedText(args?.accountId, 256) || !isBoundedText(args?.label, 120)) {
        throw new Error(`A ${displayName} account ID and label are required.`)
      }
      return service.renameAccount(args.accountId, args.label)
    }
  )
  ipcMain.handle(`${channelPrefix}:remove`, (_event, args: { accountId?: unknown }) => {
    if (!isBoundedText(args?.accountId, 256)) {
      throw new Error(`A ${displayName} account ID is required.`)
    }
    return service.removeAccount(args.accountId)
  })
}
