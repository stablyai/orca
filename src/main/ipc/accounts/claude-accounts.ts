import { ipcMain } from 'electron'
import type { ClaudeAccountService } from '../../claude-accounts/service'
import type { ClaudeAccountSelectionTarget } from '../../claude-accounts/selection/runtime-selection'
import { openAccountSignInLink } from './account-sign-in-link-opener'
import type { ClaudeHostRunningSessionsMove } from '../../../shared/agent-accounts/managed-account-types'
import type { ClaudeHostSelectionChange } from '../../../shared/agent-accounts/claude/claude-pane-account-folder'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'

/** The host's mover for the running Claude terminals the window doesn't hold. */
export type MoveUnheldClaudeSessions = (
  change: ClaudeHostSelectionChange,
  heldPtyIds: ReadonlySet<string>
) => Promise<ClaudeHostRunningSessionsMove | undefined>

export function registerClaudeAccountIpcHandlers(
  claudeAccounts: ClaudeAccountService,
  moveUnheldSessions: MoveUnheldClaudeSessions,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  ipc.handle('claudeAccounts:list', () => claudeAccounts.listAccounts())
  ipc.handle(
    'claudeAccounts:add',
    (_event, args?: ClaudeAccountSelectionTarget & { copyLink?: boolean }) =>
      claudeAccounts.addAccount(args, args?.copyLink)
  )
  ipc.handle('claudeAccounts:cancelPendingLogin', () => claudeAccounts.cancelPendingLogin())
  ipc.handle(
    'claudeAccounts:reauthenticate',
    (_event, args: { accountId: string; copyLink?: boolean }) =>
      claudeAccounts.reauthenticateAccount(args.accountId, args.copyLink)
  )
  ipc.handle('claudeAccounts:waitForSignInLink', () => claudeAccounts.waitForSignInLink())
  ipc.handle('claudeAccounts:remove', (_event, args: { accountId: string }) =>
    claudeAccounts.removeAccount(args.accountId)
  )
  ipc.handle(
    'claudeAccounts:rename',
    (_event, args: { accountId: string; displayName: string | null }) =>
      claudeAccounts.renameAccount(args.accountId, args.displayName)
  )
  ipc.handle(
    'claudeAccounts:select',
    (_event, args: { accountId: string | null } & ClaudeAccountSelectionTarget) =>
      args.runtime
        ? claudeAccounts.selectAccountForTarget(args.accountId, args)
        : claudeAccounts.selectAccount(args.accountId)
  )
  ipc.handle(
    'claudeAccounts:moveUnheldRunningSessions',
    (_event, args: { change: ClaudeHostSelectionChange; heldPtyIds: string[] }) =>
      moveUnheldSessions(args.change, new Set(args.heldPtyIds))
  )
}

export function registerClaudeAccountHandlers(
  claudeAccounts: ClaudeAccountService,
  moveUnheldSessions: MoveUnheldClaudeSessions
): void {
  claudeAccounts.setWslSignInLinkOpener((signInLink) => openAccountSignInLink('claude', signInLink))
  registerClaudeAccountIpcHandlers(claudeAccounts, moveUnheldSessions)
}
