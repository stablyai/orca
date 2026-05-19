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
  // Why: read-only live probe — translates HTTP status from the provider's
  // /v1/models endpoint into the locked validation strings consumed by the
  // renderer pill. Errors from the underlying handler are turned into a
  // typed ValidationResult so the renderer never sees raw fetch exceptions.
  ipcMain.handle('claudeAccounts:validate', async (_event, args: { accountId: string }) => {
    try {
      return await claudeAccounts.validateAccount(args.accountId)
    } catch {
      return { ok: false, reason: 'Account not found.' }
    }
  })
  // Why: P2 — workspace override is a pointer-only write into the persistence
  // settings. PTY launch consults the resolver before falling back to the
  // global active account. (#2314)
  ipcMain.handle(
    'claudeAccounts:setWorkspaceOverride',
    (_event, args: { worktreeId: string; accountId: string }) =>
      claudeAccounts.setWorkspaceOverride(args)
  )
  ipcMain.handle(
    'claudeAccounts:clearWorkspaceOverride',
    (_event, args: { worktreeId: string }) => claudeAccounts.clearWorkspaceOverride(args)
  )
  // Why: P2 — Detect/Validate probe for AddAccountModal. Validates a
  // candidate input without persisting the account. Errors are converted to
  // a typed ValidationResult so the renderer never sees raw exceptions.
  ipcMain.handle('claudeAccounts:validateInput', async (_event, input: AddClaudeAccountInput) => {
    try {
      return await claudeAccounts.validateInput(input)
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : 'Validation failed.'
      }
    }
  })
}
