// Whether picking another saved Antigravity account moves a host chat on: a pick swaps agy's one
// Google login, so only chats running on that login follow it. Reads Orca's saved accounts only,
// never agy's login, whose read may raise a keychain dialog.

import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { isAntigravityHostAccountHome } from './antigravity-host-acp'
import { isAntigravityAgyOrcaAccountHome } from './antigravity-agy-orca-home'
import { savedChatAuthUsesAgyLogin } from './antigravity-chat-route'

export type AntigravitySavedAccounts = {
  selectedAccountId: string | null
  accountIds: readonly string[]
}

export type AntigravityChatSwitchSources = {
  /** The host's saved chat sign-in method, which an Orca-home chat's next start uses. */
  savedChatAuth: unknown
  /** True while an in-app agy sign-in may hold a login Orca hasn't saved yet. */
  signInRunning: () => boolean
  savedAccounts: () => Promise<AntigravitySavedAccounts>
}

export async function antigravityChatCanSwitchAccount(
  record: Pick<AgentSessionRecord, 'provider' | 'location' | 'accountHome'>,
  sources: AntigravityChatSwitchSources
): Promise<boolean> {
  if (record.provider !== 'antigravity' || record.location.wslDistro !== null) {
    return false
  }
  const home = record.accountHome
  const onAgyLogin =
    isAntigravityHostAccountHome(home) ||
    (isAntigravityAgyOrcaAccountHome(home) && savedChatAuthUsesAgyLogin(sources.savedChatAuth))
  if (!onAgyLogin || sources.signInRunning()) {
    return false
  }
  const { selectedAccountId, accountIds } = await sources.savedAccounts()
  return accountIds.length >= 2 && accountIds.some((id) => id !== selectedAccountId)
}

/** The host's own sources, loaded only when a usage-limited Antigravity chat asks. */
export async function hostAntigravityChatCanSwitchAccount(
  record: Pick<AgentSessionRecord, 'provider' | 'location' | 'accountHome'>,
  savedChatAuth: unknown
): Promise<boolean> {
  if (record.provider !== 'antigravity') {
    return false
  }
  const [{ getAntigravityAccountService }, { antigravitySignInHoldsNativeLogin }] =
    await Promise.all([import('./native-account-host'), import('./antigravity-chat-sign-in')])
  return antigravityChatCanSwitchAccount(record, {
    savedChatAuth,
    signInRunning: antigravitySignInHoldsNativeLogin,
    savedAccounts: async () =>
      (await getAntigravityAccountService({ runtime: 'host' })).readSelection()
  })
}
