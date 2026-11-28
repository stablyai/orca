import type { ClaudeAccountService } from '../../claude-accounts/service'
import { openAccountSignInLink } from './account-sign-in-link-opener'
import type { MoveUnheldClaudeSessions } from './claude-accounts'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'

const CLAUDE_ACCOUNT_IPC_CHANNELS = [
  'claudeAccounts:list',
  'claudeAccounts:add',
  'claudeAccounts:cancelPendingLogin',
  'claudeAccounts:reauthenticate',
  'claudeAccounts:waitForSignInLink',
  'claudeAccounts:remove',
  'claudeAccounts:rename',
  'claudeAccounts:select',
  'claudeAccounts:moveUnheldRunningSessions'
] as const

export function registerLazyClaudeAccountHandlers(
  claudeAccounts: ClaudeAccountService,
  moveUnheldSessions: MoveUnheldClaudeSessions
): void {
  claudeAccounts.setWslSignInLinkOpener((signInLink) => openAccountSignInLink('claude', signInLink))

  registerLazyIpcHandleGroup(CLAUDE_ACCOUNT_IPC_CHANNELS, async (ipc) => {
    const { registerClaudeAccountIpcHandlers } = await import('./claude-accounts')
    registerClaudeAccountIpcHandlers(claudeAccounts, moveUnheldSessions, ipc)
  })
}
