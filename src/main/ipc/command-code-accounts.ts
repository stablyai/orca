import { dialog, ipcMain } from 'electron'
import type { CommandCodeAccountService } from '../command-code-accounts/service'
import { isBoundedText } from './bounded-account-text'

export function registerCommandCodeAccountHandlers(
  commandCodeAccounts: CommandCodeAccountService
): void {
  ipcMain.handle('commandCodeAccounts:list', () => commandCodeAccounts.listAccounts())
  ipcMain.handle('commandCodeAccounts:import', async (_event, args: { label?: unknown }) => {
    if (!isBoundedText(args?.label, 120)) {
      throw new Error('A Command Code account label is required.')
    }
    const selection = await dialog.showOpenDialog({
      title: 'Select an existing Command Code home',
      properties: ['openDirectory']
    })
    const sourceHome = selection.filePaths[0]
    if (selection.canceled || !sourceHome) {
      throw new Error('Command Code account import was cancelled.')
    }
    return commandCodeAccounts.addAccountFromHome(sourceHome, args.label)
  })
  ipcMain.handle('commandCodeAccounts:select', (_event, args: { accountId?: unknown }) => {
    if (args?.accountId !== null && !isBoundedText(args?.accountId, 256)) {
      throw new Error('Invalid Command Code account ID.')
    }
    return commandCodeAccounts.selectAccount(args.accountId)
  })
  ipcMain.handle(
    'commandCodeAccounts:rename',
    (_event, args: { accountId?: unknown; label?: unknown }) => {
      if (!isBoundedText(args?.accountId, 256) || !isBoundedText(args?.label, 120)) {
        throw new Error('A Command Code account ID and label are required.')
      }
      return commandCodeAccounts.renameAccount(args.accountId, args.label)
    }
  )
  ipcMain.handle('commandCodeAccounts:remove', (_event, args: { accountId?: unknown }) => {
    if (!isBoundedText(args?.accountId, 256)) {
      throw new Error('A Command Code account ID is required.')
    }
    return commandCodeAccounts.removeAccount(args.accountId)
  })
}
