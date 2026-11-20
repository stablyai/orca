import { registerAppHandler } from '../app-registry/app-handler-registry'

import type { ClaudeAccountService } from '../../claude-accounts/service'
import type { ClaudeAccountSelectionTarget } from '../../claude-accounts/selection/runtime-selection'
import { openAccountSignInLink } from './account-sign-in-link-opener'
import type { ClaudeHostRunningSessionsMove } from '../../../shared/agent-accounts/managed-account-types'
import type { ClaudeHostSelectionChange } from '../../../shared/agent-accounts/claude/claude-pane-account-folder'

/** The host's mover for the running Claude terminals the window doesn't hold. */
export type MoveUnheldClaudeSessions = (
  change: ClaudeHostSelectionChange,
  heldPtyIds: ReadonlySet<string>
) => Promise<ClaudeHostRunningSessionsMove | undefined>

export function registerClaudeAccountHandlers(
  claudeAccounts: ClaudeAccountService,
  moveUnheldSessions: MoveUnheldClaudeSessions
): void {
  claudeAccounts.setWslSignInLinkOpener((signInLink) => openAccountSignInLink('claude', signInLink))
  registerAppHandler('claudeAccounts:list', () => claudeAccounts.listAccounts())
  registerAppHandler(
    'claudeAccounts:add',
    (_event, args?: ClaudeAccountSelectionTarget & { copyLink?: boolean }) =>
      claudeAccounts.addAccount(args, args?.copyLink)
  )
  registerAppHandler('claudeAccounts:cancelPendingLogin', () => claudeAccounts.cancelPendingLogin())
  registerAppHandler(
    'claudeAccounts:reauthenticate',
    (_event, args: { accountId: string; copyLink?: boolean }) =>
      claudeAccounts.reauthenticateAccount(args.accountId, args.copyLink)
  )
  registerAppHandler('claudeAccounts:waitForSignInLink', () => claudeAccounts.waitForSignInLink())
  registerAppHandler('claudeAccounts:remove', (_event, args: { accountId: string }) =>
    claudeAccounts.removeAccount(args.accountId)
  )
  registerAppHandler(
    'claudeAccounts:rename',
    (_event, args: { accountId: string; displayName: string | null }) =>
      claudeAccounts.renameAccount(args.accountId, args.displayName)
  )
  registerAppHandler(
    'claudeAccounts:select',
    (_event, args: { accountId: string | null } & ClaudeAccountSelectionTarget) =>
      args.runtime
        ? claudeAccounts.selectAccountForTarget(args.accountId, args)
        : claudeAccounts.selectAccount(args.accountId)
  )
  ipcMain.handle(
    'claudeAccounts:moveUnheldRunningSessions',
    (_event, args: { change: ClaudeHostSelectionChange; heldPtyIds: string[] }) =>
      moveUnheldSessions(args.change, new Set(args.heldPtyIds))
  )
}
