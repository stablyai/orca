import { ipcMain } from 'electron'
import type { ClaudeAccountAddTarget, ClaudeAccountService } from '../claude-accounts/service'
import type { ClaudeAccountSelectionTarget } from '../claude-accounts/runtime-selection'
import type { ClaudeRateLimitAccountsState } from '../../shared/managed-account-types'
import { daemonHostsTerminalsWithoutClaudeAccountFunction } from '../daemon/daemon-provider-state'
import { isUnfinishedClaudeSignIn } from '../../shared/claude-unfinished-sign-in'

export function registerClaudeAccountHandlers(
  claudeAccounts: ClaudeAccountService,
  olderTerminalsRunning: () => boolean = daemonHostsTerminalsWithoutClaudeAccountFunction
): void {
  // Why derived per call: the notice must end as soon as the last pre-update terminal closes.
  const withTerminalNotice = async (
    state: ClaudeRateLimitAccountsState | Promise<ClaudeRateLimitAccountsState>
  ): Promise<ClaudeRateLimitAccountsState> => {
    const resolved = await state
    // Why only with an account: with none saved (drafts hold no login), every terminal already
    // uses the personal login.
    if (resolved.accounts.every(isUnfinishedClaudeSignIn)) {
      return resolved
    }
    return olderTerminalsRunning() ? { ...resolved, olderTerminalsRunning: true } : resolved
  }
  ipcMain.handle('claudeAccounts:list', () => withTerminalNotice(claudeAccounts.listAccounts()))
  ipcMain.handle('claudeAccounts:add', (_event, args?: ClaudeAccountAddTarget) =>
    withTerminalNotice(claudeAccounts.addAccount(args))
  )
  ipcMain.handle('claudeAccounts:cancelPendingLogin', () => claudeAccounts.cancelPendingLogin())
  ipcMain.handle('claudeAccounts:reauthenticate', (_event, args: { accountId: string }) =>
    withTerminalNotice(claudeAccounts.reauthenticateAccount(args.accountId))
  )
  ipcMain.handle('claudeAccounts:remove', (_event, args: { accountId: string }) =>
    withTerminalNotice(claudeAccounts.removeAccount(args.accountId))
  )
  ipcMain.handle(
    'claudeAccounts:select',
    (_event, args: { accountId: string | null } & ClaudeAccountSelectionTarget) => {
      return withTerminalNotice(
        args.runtime
          ? claudeAccounts.selectAccountForTarget(args.accountId, args)
          : claudeAccounts.selectAccount(args.accountId)
      )
    }
  )
}
