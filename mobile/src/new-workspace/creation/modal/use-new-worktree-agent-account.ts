import { useEffect, useState } from 'react'
import {
  pinnableHostAccounts,
  type PinnableAgent,
  type WorktreeAccountPins
} from '../../../../../src/shared/worktree-account-pin-settings'
import { decodeAccountsSnapshot, type AccountsSnapshot } from '../../../accounts/accounts-snapshot'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'

export const FOLLOW_SELECTED_ACCOUNT = '__follow__'

function pinnableAgent(agentId: string): PinnableAgent | null {
  return agentId === 'claude' || agentId === 'codex' ? agentId : null
}

/**
 * Worker accounts (#9496): the desktop account a new worktree's Claude or Codex agent starts on.
 * Offered only when the worktree is created on the desktop itself, since pins name its accounts.
 */
export function useNewWorktreeAgentAccount(args: {
  client: RpcClient | null
  visible: boolean
  agentId: string
  onDesktop: boolean
}) {
  const t = useMobileTranslation()
  const [snapshot, setSnapshot] = useState<AccountsSnapshot | null>(null)
  const [chosen, setChosen] = useState<WorktreeAccountPins>({})
  const { client, visible } = args

  useEffect(() => {
    if (!client || !visible) {
      return
    }
    let current = true
    void client
      .sendRequest('accounts.list')
      .then((res) => {
        if (current && res.ok) {
          setSnapshot(decodeAccountsSnapshot(res.result))
        }
      })
      // Without the list the row just stays hidden; the worktree follows the selected account.
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [client, visible])

  const agent = pinnableAgent(args.agentId)
  const accounts =
    agent && args.onDesktop && snapshot
      ? pinnableHostAccounts(
          {
            claudeManagedAccounts: snapshot.claude.accounts,
            codexManagedAccounts: snapshot.codex.accounts
          },
          agent
        )
      : []
  if (!agent || accounts.length === 0) {
    return null
  }
  const followLabel = t('components.newWorktreeAccount.followSelection', 'Follow selected account')
  const accountId = accounts.some((a) => a.id === chosen[agent]) ? chosen[agent] : undefined
  return {
    title:
      agent === 'claude'
        ? t('components.newWorktreeAccount.claude', 'Claude Account')
        : t('components.newWorktreeAccount.codex', 'Codex Account'),
    label: accounts.find((a) => a.id === accountId)?.email ?? followLabel,
    items: [
      { id: FOLLOW_SELECTED_ACCOUNT, label: followLabel },
      ...accounts.map((a) => ({ id: a.id, label: a.email }))
    ],
    selectedId: accountId ?? FOLLOW_SELECTED_ACCOUNT,
    select: (id: string) =>
      setChosen((previous) => ({
        ...previous,
        [agent]: id === FOLLOW_SELECTED_ACCOUNT ? undefined : id
      })),
    accountPins: accountId ? { [agent]: accountId } : undefined
  }
}
