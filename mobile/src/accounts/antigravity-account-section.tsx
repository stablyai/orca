import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import {
  ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY,
  PHONE_PROVIDER_ACCOUNT_SWITCH_RUNTIME_CAPABILITY
} from '../../../src/shared/remote-runtime/protocol/account-runtime-capabilities'
import { ANTIGRAVITY_ACCOUNT_ACTION_TIMEOUT_MS } from '../../../src/shared/agent-accounts/antigravity/antigravity-account-types'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { MobileAgentIcon } from '../components/icons/MobileAgentIcon'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { startRuntimeCapabilityProbe } from '../transport/connection/runtime-capability-probe'
import {
  ANTIGRAVITY_HOST_TARGET,
  listAntigravityAccounts,
  selectAntigravityAccount,
  type AntigravityAccountState
} from './provider-account-operations'
import { useThemedStyles } from '../theme/themed-styles'
import { stylesSheet } from './mobile-accounts-screen-styles'

export type ProviderAccountSwitch = {
  /** The host takes a phone's OpenCode, Devin and Antigravity switches. */
  supported: boolean
  /** Saved agy accounts on the host, or null where the phone can't switch them. */
  antigravity: AntigravityAccountState | null
  replaceAntigravity: (state: AntigravityAccountState) => void
}

export function useProviderAccountSwitch(
  client: RpcClient | null,
  live: boolean,
  reloadKey: number
): ProviderAccountSwitch {
  const [supported, setSupported] = useState(false)
  const [antigravity, setAntigravity] = useState<AntigravityAccountState | null>(null)
  // A select replaces the list. A list that started earlier must not write back over it.
  const generation = useRef(0)
  const replaceAntigravity = (next: AntigravityAccountState): void => {
    generation.current += 1
    setAntigravity(next)
  }
  useEffect(() => {
    if (!client || !live) {
      return
    }
    let cancelled = false
    // Older hosts list these accounts but refuse a phone's switch, so they get no section.
    const stop = startRuntimeCapabilityProbe(client, (capabilities) => {
      if (cancelled) {
        return
      }
      const switchable = capabilities.includes(PHONE_PROVIDER_ACCOUNT_SWITCH_RUNTIME_CAPABILITY)
      setSupported(switchable)
      if (!switchable || !capabilities.includes(ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY)) {
        setAntigravity(null)
        return
      }
      const listedAt = generation.current
      void listAntigravityAccounts
        .request(client, ANTIGRAVITY_HOST_TARGET)
        .then((response) => {
          if (!cancelled && generation.current === listedAt) {
            setAntigravity(listAntigravityAccounts.interpret(response))
          }
        })
        // A failed read keeps the last list.
        .catch(() => {})
    })
    return () => {
      cancelled = true
      stop()
    }
  }, [client, live, reloadKey])
  return { supported, antigravity, replaceAntigravity }
}

export function antigravityBusyId(accountId: string): string {
  return `antigravity:${accountId}`
}

/** What each saved row says, as desktop Settings words it. */
function antigravityRowNotes(state: AntigravityAccountState) {
  // Until the host reads agy's login it can't tell which account holds it, so nothing changed yet.
  const unread = state.currentAccount?.unread === true
  const moved =
    !unread && state.selectedAccountId !== null && state.activeAccountId !== state.selectedAccountId
  // A running agy on another saved account wrote its login back; the next launch restores the selection.
  const launchesUse =
    moved &&
    state.restoresSelectionAtLaunch === true &&
    state.activeAccountId !== null &&
    state.accounts.some((account) => account.id === state.selectedAccountId)
      ? state.selectedAccountId
      : null
  // Desktop warns only where agy is signed out or on a login Orca hasn't saved.
  const changed = moved && (!state.currentAccount || state.activeAccountId === null)
  return { launchesUse, changed }
}

export function AntigravityAccountSection({
  state,
  busyAccountId,
  switchBlocked,
  onSelect
}: {
  state: AntigravityAccountState | null
  busyAccountId: string | null
  switchBlocked: boolean
  onSelect: (accountId: string) => void
}) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  if (!state || state.accounts.length === 0) {
    return null
  }
  const { launchesUse, changed } = antigravityRowNotes(state)
  return (
    <View>
      <SectionHeader
        title={TUI_AGENT_DISPLAY_NAMES.antigravity}
        icon={<MobileAgentIcon agentId="antigravity" size={14} />}
      />
      <ListGroup>
        {state.accounts.map((account) => {
          const active = state.activeAccountId === account.id
          // agy on a saved login other than the selection can still be picked, which selects it.
          const current =
            active && (state.selectedAccountId === null || state.selectedAccountId === account.id)
          return (
            <ListRow
              key={account.id}
              title={account.email ?? t('accounts.screen.antigravitySaved', 'Saved Google account')}
              subtitle={
                account.id === launchesUse
                  ? t('accounts.screen.antigravityLaunchesUse', 'New agy launches use this account')
                  : launchesUse && active
                    ? t('accounts.screen.antigravityLoginNow', "agy's login right now")
                    : undefined
              }
              accessory={
                busyAccountId === antigravityBusyId(account.id) ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : undefined
              }
              selected={active}
              onPress={switchBlocked || current ? undefined : () => onSelect(account.id)}
            />
          )
        })}
      </ListGroup>
      {changed ? (
        <Text style={styles.groupNote}>
          {t(
            'accounts.screen.antigravityChanged',
            'The native account changed. Select a saved account again before launching agy.'
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
    // Reading agy's login may raise a keychain dialog on the host; desktop waits as long.
    await selectAntigravityAccount.request(
      client,
      { target: ANTIGRAVITY_HOST_TARGET, accountId },
      { timeoutMs: ANTIGRAVITY_ACCOUNT_ACTION_TIMEOUT_MS }
    )
  )
}
