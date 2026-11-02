import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY } from '../../../src/shared/account-runtime-capabilities'
import {
  collectProviderUsageMeters,
  hasRenderableProviderUsage,
  providerUsagePlaceholder,
  type AccountsSnapshot
} from '../components/account-usage-state'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc-client'
import { startRuntimeCapabilityProbe } from '../transport/runtime-capability-probe'
import {
  decodeAntigravityAccountState,
  type AntigravityAccountState
} from './antigravity-account-state'
import { styles } from './mobile-accounts-screen-styles'
import { UsageMeterList } from './provider-usage-section'

const HOST_TARGET = { runtime: 'host' as const }

// Saved agy accounts are a separate RPC. Probe the capability first so older hosts are left alone.
export function AntigravityAccountSection({
  snapshot,
  now,
  client,
  connected,
  reloadKey,
  busyAccountId,
  disabled,
  onNotice,
  onChanged
}: {
  snapshot: AccountsSnapshot
  now: number
  client: RpcClient | null
  connected: boolean
  reloadKey: number
  busyAccountId: string | null
  disabled: boolean
  onNotice: (notice: { title: string; message: string }) => void
  onChanged: () => Promise<void>
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [supported, setSupported] = useState(false)
  const [accounts, setAccounts] = useState<AntigravityAccountState | null>(null)
  const [selectingId, setSelectingId] = useState<string | null>(null)

  useEffect(() => {
    setSupported(false)
    setAccounts(null)
    setSelectingId(null)
  }, [client, connected])

  useEffect(() => {
    if (!client || !connected) {
      return
    }
    let cancelled = false
    const stop = startRuntimeCapabilityProbe(client, (capabilities) => {
      if (cancelled) {
        return
      }
      const enabled = capabilities.includes(ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY)
      setSupported(enabled)
      if (!enabled) {
        setAccounts(null)
        return
      }
      // A disconnect or an older host that advertised the capability must not reject over the screen.
      void client
        .sendRequest('accounts.antigravityList', HOST_TARGET)
        .then((response) => {
          if (cancelled || !response.ok) {
            return
          }
          setAccounts(decodeAntigravityAccountState(response.result))
        })
        .catch(() => {})
    })
    return () => {
      cancelled = true
      stop()
    }
  }, [client, connected, reloadKey])

  const limits = snapshot.rateLimits.antigravity ?? null
  const showUsage = hasRenderableProviderUsage(snapshot, 'antigravity')
  const saved = accounts?.accounts ?? []
  const currentEmail = accounts?.currentAccount?.email?.trim() || null
  const showCurrent = saved.length === 0 && currentEmail != null
  if (!showUsage && saved.length === 0 && !showCurrent) {
    return null
  }
  const collected = showUsage ? collectProviderUsageMeters('antigravity', limits) : []
  const meters =
    showUsage && collected.length === 0
      ? [providerUsagePlaceholder('antigravity', limits)]
      : collected
  const changed =
    accounts?.selectedAccountId != null && accounts.activeAccountId !== accounts.selectedAccountId

  const selectAccount = (accountId: string) => {
    if (!client || selectingId) {
      return
    }
    setSelectingId(accountId)
    void (async () => {
      const title = t('accounts.screen.switchFailed', 'Could not switch account')
      try {
        const response = await client.sendRequest('accounts.antigravitySelect', {
          target: HOST_TARGET,
          accountId
        })
        if (!response.ok) {
          onNotice({ title, message: response.error.message })
          return
        }
        setAccounts(decodeAntigravityAccountState(response.result) ?? accounts)
        await onChanged()
      } catch (error) {
        onNotice({ title, message: error instanceof Error ? error.message : String(error) })
      } finally {
        setSelectingId(null)
      }
    })()
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <MobileAgentIcon agentId="antigravity" size={14} />
        <Text style={styles.sectionHeading}>{t('accounts.screen.antigravity', 'Antigravity')}</Text>
      </View>
      <View style={styles.card}>
        {showUsage ? (
          <View style={styles.row}>
            <View style={styles.rowMain}>
              <UsageMeterList meters={meters} now={now} />
              {limits?.error ? (
                <Text style={styles.errorText} numberOfLines={3}>
                  {limits.error}
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}
        {changed ? (
          <Text style={[styles.errorText, styles.row]}>
            {t(
              'accounts.screen.antigravityChanged',
              'The native account changed. Select a saved account again before launching.'
            )}
          </Text>
        ) : null}
        {showCurrent ? (
          <>
            {showUsage || changed ? <View style={styles.separator} /> : null}
            <View style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {currentEmail}
                </Text>
                <Text style={styles.rowSubtitle}>
                  {t('accounts.screen.signedIn', 'Signed in on this host')}
                </Text>
              </View>
            </View>
          </>
        ) : null}
        {saved.map((account, index) => {
          const selected =
            accounts?.selectedAccountId === account.id && accounts.activeAccountId === account.id
          const showSeparator = showUsage || changed || index > 0
          return (
            <View key={account.id}>
              {showSeparator ? <View style={styles.separator} /> : null}
              <Pressable
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={() => selectAccount(account.id)}
                disabled={
                  disabled ||
                  !supported ||
                  selected ||
                  busyAccountId !== null ||
                  selectingId !== null
                }
              >
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {account.email ?? t('accounts.screen.antigravitySaved', 'Saved Google account')}
                  </Text>
                  {accounts?.activeAccountId === account.id &&
                  accounts.selectedAccountId !== account.id ? (
                    <Text style={styles.rowSubtitle}>
                      {t('accounts.screen.antigravityNative', 'Native account')}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.rowTrailing}>
                  {selected ? (
                    <Check size={16} color={colors.accentBlue} />
                  ) : selectingId === account.id ? (
                    <ActivityIndicator size="small" color={colors.textSecondary} />
                  ) : null}
                </View>
              </Pressable>
            </View>
          )
        })}
      </View>
    </View>
  )
}
