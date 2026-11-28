import { ANTIGRAVITY_ACCOUNT_ACTION_TIMEOUT_MS } from '../../../src/shared/agent-accounts/antigravity/antigravity-account-types'
import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session/options/protocol/agent-session-options-result'
import type { Translate } from '../i18n/mobile-i18n'
import { callAgentSession } from '../session/native-chat/agent-session/mobile-structured-agent-session-rpc'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  ANTIGRAVITY_HOST_TARGET,
  listAntigravityAccounts,
  selectAntigravityAccount,
  type AntigravityAccountState
} from './provider-account-operations'

export async function requestAntigravitySelect(
  client: RpcClient,
  accountId: string
): Promise<AntigravityAccountState> {
  return selectAntigravityAccount.interpret(
    // Reading agy's login may raise a keychain dialog on the host; desktop waits as long.
    await selectAntigravityAccount.request(
      client,
      { target: ANTIGRAVITY_HOST_TARGET, accountId },
      { timeoutMs: ANTIGRAVITY_ACCOUNT_ACTION_TIMEOUT_MS }
    )
  )
}

/** Desktop's switch toast, in the one line a phone toast shows. */
export function antigravitySwitchedMessage(
  t: Translate,
  state: AntigravityAccountState,
  accountId: string
): string {
  const account = state.accounts.find((entry) => entry.id === accountId)
  return t(
    'accounts.screen.antigravitySwitched',
    'Switched to {{account}}. New chats use it now. Chats running a turn switch at their next message.',
    {
      account:
        account?.email ??
        account?.subject ??
        t('accounts.screen.antigravitySaved', 'Saved Google account')
    }
  )
}

export function antigravitySwitchFailedTitle(t: Translate): string {
  return t('accounts.screen.antigravitySwitchFailed', 'Antigravity account update failed.')
}

/** The account a chat's next message runs on: the selection, which launches put back. */
export function antigravityChatAccountId(state: AntigravityAccountState): string | null {
  return state.selectedAccountId ?? state.activeAccountId
}

/** A usage-limited Antigravity chat's saved accounts, on the host that runs it. */
export type AntigravityChatAccounts = {
  list: () => Promise<AntigravityAccountState>
  /** Null when the chat can no longer move to another account. */
  select: (accountId: string) => Promise<AntigravityAccountState | null>
}

export function antigravityChatAccounts(
  client: RpcClient,
  sessionId: string
): AntigravityChatAccounts {
  return {
    list: async () =>
      listAntigravityAccounts.interpret(
        await listAntigravityAccounts.request(client, ANTIGRAVITY_HOST_TARGET)
      ),
    select: async (accountId) => {
      // The chat may have moved on since the row offered the switch.
      const options = await callAgentSession<AgentSessionOptionsResult>(
        client,
        'agentSession.options',
        { sessionId }
      )
      return options.canSwitchAntigravityAccount === true
        ? requestAntigravitySelect(client, accountId)
        : null
    }
  }
}
