import { useEffect, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY } from '../../../src/shared/remote-runtime/protocol/account-runtime-capabilities'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { MobileAgentIcon } from '../components/icons/MobileAgentIcon'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { startRuntimeCapabilityProbe } from '../transport/connection/runtime-capability-probe'
import type { ProviderRateLimits } from './accounts-snapshot'
import { ProviderUsageWindows } from './ProviderUsageWindows'
import { UsageStatusNote } from './usage/UsageStatusNote'
import {
  ANTIGRAVITY_HOST_TARGET,
  listAntigravityAccounts,
  selectAntigravityAccount,
  type AntigravityAccountState
} from './provider-account-operations'
import { styles } from './mobile-accounts-screen-styles'

/** Saved agy accounts on the host, or null where the host can't list them. */
export function useAntigravityAccounts(
  client: RpcClient | null,
  live: boolean,
  reloadKey: number
): [AntigravityAccountState | null, (state: AntigravityAccountState) => void] {
  const [state, setState] = useState<AntigravityAccountState | null>(null)
  useEffect(() => {
    if (!client || !live) {
      return
    }
    let cancelled = false
    // Probe first so a host without saved agy accounts is never asked for them.
    const stop = startRuntimeCapabilityProbe(client, (capabilities) => {
      if (cancelled) {
        return
      }
      if (!capabilities.includes(ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY)) {
        setState(null)
        return
      }
      void listAntigravityAccounts
        .request(client, ANTIGRAVITY_HOST_TARGET)
        .then((response) => {
          if (!cancelled) {
            setState(listAntigravityAccounts.interpret(response))
          }
        })
        // A failed read keeps the last list; usage stays under Other agents.
        .catch(() => {})
    })
    return () => {
      cancelled = true
      stop()
    }
  }, [client, live, reloadKey])
  return [state, setState]
}

export function antigravityBusyId(accountId: string): string {
  return `antigravity:${accountId}`
}

export function AntigravityAccountSection({
  state,
  activeUsage,
  now,
  busyAccountId,
  switchBlocked,
  onSelect
}: {
  state: AntigravityAccountState | null
  activeUsage: ProviderRateLimits | null
  now: number
  busyAccountId: string | null
  switchBlocked: boolean
  onSelect: (accountId: string) => void
}) {
  const t = useMobileTranslation()
  if (!state || state.accounts.length === 0) {
    return null
  }
  // The native login moved off the account Orca selected; launching would use the other one.
  const changed =
    state.selectedAccountId !== null && state.activeAccountId !== state.selectedAccountId
  return (
    <View>
      <SectionHeader
        title={TUI_AGENT_DISPLAY_NAMES.antigravity}
        icon={<MobileAgentIcon agentId="antigravity" size={14} />}
      />
      <ListGroup style={styles.group}>
        {state.accounts.map((account) => {
          const active = state.activeAccountId === account.id
          const selected = active && state.selectedAccountId === account.id
          const usage = active ? (activeUsage ?? account.usage ?? null) : (account.usage ?? null)
          return (
            <ListRow
              key={account.id}
              title={account.email ?? t('accounts.screen.antigravitySaved', 'Saved Google account')}
              subtitle={
                active && !selected
                  ? t('accounts.screen.antigravityNative', 'Native account')
                  : undefined
              }
              detail={
                usage ? (
                  <>
                    <ProviderUsageWindows limits={usage} now={now} />
                    <UsageStatusNote limits={usage} />
                  </>
                ) : undefined
              }
              accessory={
                busyAccountId === antigravityBusyId(account.id) ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : undefined
              }
              selected={selected}
              onPress={switchBlocked || selected ? undefined : () => onSelect(account.id)}
            />
          )
        })}
      </ListGroup>
      {changed ? (
        <Text style={styles.groupNote}>
          {t(
            'accounts.screen.antigravityChanged',
            'The native account changed. Select a saved account again before launching.'
          )}
        </Text>
      ) : null}
    </View>
  )
}

export async function requestAntigravitySelect(
  client: RpcClient,
  accountId: string
): Promise<AntigravityAccountState> {
  return selectAntigravityAccount.interpret(
    await selectAntigravityAccount.request(client, { target: ANTIGRAVITY_HOST_TARGET, accountId })
  )
}
