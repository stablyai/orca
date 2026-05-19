import { ipcMain } from 'electron'
import type { AddClaudeAccountInput } from '../../shared/types'
import type { ClaudeAccountService } from '../claude-accounts/service'

export function registerClaudeAccountHandlers(claudeAccounts: ClaudeAccountService): void {
  ipcMain.handle('claudeAccounts:list', () => claudeAccounts.listAccounts())
  // Why: polymorphic input lets new providers (anthropic-api-key, anthropic-compat)
  // reach service.addAccount; undefined preserves the legacy OAuth no-arg path.
  // The `as never` cast bridges the overloaded signature — runtime validation
  // happens in service.doAddAccountPolymorphic via the discriminator.
  ipcMain.handle('claudeAccounts:add', (_event, input?: AddClaudeAccountInput) =>
    claudeAccounts.addAccount(input as never)
  )
  ipcMain.handle('claudeAccounts:reauthenticate', (_event, args: { accountId: string }) =>
    claudeAccounts.reauthenticateAccount(args.accountId)
  )
  ipcMain.handle('claudeAccounts:remove', (_event, args: { accountId: string }) =>
    claudeAccounts.removeAccount(args.accountId)
  )
  ipcMain.handle('claudeAccounts:select', (_event, args: { accountId: string | null }) =>
    claudeAccounts.selectAccount(args.accountId)
  )
}
