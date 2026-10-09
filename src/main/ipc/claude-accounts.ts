import { ipcMain } from 'electron'
import type { ClaudeAccountService } from '../claude-accounts/service'
import type { ClaudeAccountSelectionTarget } from '../claude-accounts/runtime-selection'
import type { ClaudeSignInOptions } from '../../shared/managed-account-types'

export function registerClaudeAccountHandlers(claudeAccounts: ClaudeAccountService): void {
  ipcMain.handle('claudeAccounts:list', () => claudeAccounts.listAccounts())
  ipcMain.handle(
    'claudeAccounts:add',
    (_event, args?: ClaudeAccountSelectionTarget & ClaudeSignInOptions) =>
      claudeAccounts.addAccount(args, { copyLink: args?.copyLink })
  )
  ipcMain.handle('claudeAccounts:cancelPendingLogin', () => claudeAccounts.cancelPendingLogin())
  ipcMain.handle(
    'claudeAccounts:reauthenticate',
    (_event, args: { accountId: string } & ClaudeSignInOptions) =>
      claudeAccounts.reauthenticateAccount(args.accountId, { copyLink: args.copyLink })
  )
  ipcMain.handle('claudeAccounts:waitForSignInLink', () => claudeAccounts.waitForSignInLink())
  ipcMain.handle('claudeAccounts:remove', (_event, args: { accountId: string }) =>
    claudeAccounts.removeAccount(args.accountId)
  )
  ipcMain.handle(
    'claudeAccounts:select',
    (_event, args: { accountId: string | null } & ClaudeAccountSelectionTarget) =>
      args.runtime
        ? claudeAccounts.selectAccountForTarget(args.accountId, args)
        : claudeAccounts.selectAccount(args.accountId)
  )
}
