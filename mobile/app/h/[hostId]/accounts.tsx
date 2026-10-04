import { useEffect, useState, useCallback, useSyncExternalStore } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  Alert
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft, Check, RefreshCw, User } from 'lucide-react-native'
import { loadHosts } from '../../../src/transport/host-store'
import { useHostClient } from '../../../src/transport/client-context'
import { colors, spacing } from '../../../src/theme/mobile-theme'
import { styles } from '../../../src/accounts/mobile-accounts-screen-styles'
import { useHostAccountsRefresh } from '../../../src/accounts/use-host-accounts-refresh'
import { getHostAccountEvidence } from '../../../src/accounts/host-account-evidence'
import { useNow } from '../../../src/hooks/use-now'
import { ClaudeIcon, OpenAIIcon } from '../../../src/components/AgentIcons'
import {
  type AccountsSnapshot,
  type ProviderKey,
  decodeAccountsSnapshot,
  getActiveProviderRateLimits,
  getInactiveProviderUsage,
  getUsageBarState,
  getWindowResetLabel,
  hasActiveProviderUsage,
  UsageBar
} from '../../../src/components/AccountUsage'
import {
  getActiveCodexAccountIdForRateLimitTarget,
  getCodexResetCreditSummary
} from '../../../src/components/codex-reset-credit'
import { CodexResetCreditAction } from '../../../src/components/CodexResetCreditAction'
import { useCodexResetCreditAction } from '../../../src/components/use-codex-reset-credit-action'
import { DeepSeekBalanceCard } from '../../../src/components/DeepSeekBalanceCard'
import type { RpcClient } from '../../../src/transport/rpc-client'
import type { ConnectionState } from '../../../src/transport/types'

export default function AccountsScreen() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const { client, clientId, state } = useHostClient(hostId)
  const subscribe = useCallback(
    (listener: () => void) => client?.onStateChange(listener) ?? (() => {}),
    [client]
  )
  const readScope = useCallback(
    () => JSON.stringify([hostId, clientId, state, client?.getGeneration?.()]),
    [client, clientId, hostId, state]
  )
  const scope = useSyncExternalStore(subscribe, readScope, readScope)
  return <HostAccountsScreen key={scope} hostId={hostId} client={client} connState={state} />
}

function HostAccountsScreen({
  hostId,
  client,
  connState
}: {
  hostId: string
  client: RpcClient | null
  connState: ConnectionState
}) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [hostName, setHostName] = useState<string>('')
  const [snapshot, setSnapshot] = useState<AccountsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null)
  const [clockEnabled, setClockEnabled] = useState(false)
  const accountEvidence = client ? getHostAccountEvidence(client, hostId) : null

  const acceptSnapshot = useCallback((nextSnapshot: AccountsSnapshot) => {
    setSnapshot(nextSnapshot)
    setError(null)
  }, [])
  const rejectInvalidSnapshot = useCallback(() => {
    // Why: a stale snapshot can expose a finite reset action for the wrong
    // account; fail closed if a host sends a shape this mobile cannot prove.
    setSnapshot(null)
    setError('Invalid accounts snapshot from host')
  }, [])
  const { refresh, refreshing } = useHostAccountsRefresh({
    client,
    hostId,
    connState,
    onSnapshot: acceptSnapshot,
    onInvalidSnapshot: rejectInvalidSnapshot,
    onError: setError
  })
  const {
    supported: codexResetSupported,
    resetting: resettingCodex,
    resetScope,
    scopeLabel: resetScopeLabel,
    confirmReset: confirmCodexReset
  } = useCodexResetCreditAction({
    client,
    connected: connState === 'connected',
    hostId,
    snapshot,
    accountMutationBusy: busyAccountId !== null,
    onSnapshot: acceptSnapshot
  })

  useFocusEffect(
    useCallback(() => {
      setClockEnabled(true)
      return () => setClockEnabled(false)
    }, [])
  )
  // Why: snapshot pushes only arrive when the desktop's rate-limit poll completes.
  const now = useNow(60_000, clockEnabled)

  useEffect(() => {
    if (!hostId) {
      return
    }
    let stale = false
    void loadHosts().then((hosts) => {
      if (stale) {
        return
      }
      const host = hosts.find((h) => h.id === hostId)
      if (!host) {
        setError('Host not found')
        return
      }
      setHostName(host.name)
    })
    return () => {
      stale = true
    }
  }, [hostId])

  // Why: subscribe to streaming snapshot updates so usage bars refresh in
  // place when the desktop's rate-limit poll completes (every 5 min) or
  // when the user switches accounts. Falls back to a one-shot accounts.list
  // if the subscription stream errors.
  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    let disposed = false
    const unsubscribe = client.subscribe('accounts.subscribe', null, (payload) => {
      if (disposed || !payload || typeof payload !== 'object') {
        return
      }
      if ('type' in payload && (payload.type === 'ready' || payload.type === 'snapshot')) {
        accountEvidence?.retire()
        try {
          acceptSnapshot(
            decodeAccountsSnapshot('snapshot' in payload ? payload.snapshot : undefined)
          )
        } catch {
          rejectInvalidSnapshot()
        }
      }
    })
    return () => {
      disposed = true
      accountEvidence?.retire()
      unsubscribe()
    }
  }, [acceptSnapshot, accountEvidence, client, connState, rejectInvalidSnapshot])

  const selectAccount = useCallback(
    async (provider: ProviderKey, accountId: string | null) => {
      if (!client) {
        return
      }
      const codexTarget = provider === 'codex' ? snapshot?.rateLimits.codexTarget : null
      if (provider === 'codex' && !codexTarget) {
        return
      }
      setBusyAccountId(accountId ?? `${provider}:default`)
      const method =
        provider === 'claude'
          ? 'accounts.selectClaude'
          : codexTarget?.runtime === 'wsl'
            ? 'accounts.selectCodexForTarget'
            : 'accounts.selectCodex'
      try {
        // Why: old hosts silently strip unknown target fields. Use the distinct
        // targeted RPC for WSL so version skew fails before mutating host state.
        const params =
          codexTarget?.runtime === 'wsl' ? { accountId, target: codexTarget } : { accountId }
        const res = await client.sendRequest(method, params)
        if (!res.ok) {
          Alert.alert('Could not switch account', res.error.message)
        } else {
          // Why: optimistic refresh — the streaming subscription will also
          // emit, but a one-shot keeps the UI responsive even if the stream
          // is temporarily disconnected.
          await refresh()
        }
      } catch (e) {
        Alert.alert('Could not switch account', e instanceof Error ? e.message : String(e))
      } finally {
        setBusyAccountId(null)
      }
    },
    [client, refresh, snapshot]
  )

  const renderProviderSection = (provider: ProviderKey, title: string) => {
    if (!snapshot) {
      return null
    }
    const state = provider === 'claude' ? snapshot.claude : snapshot.codex
    const activeAccountId =
      provider === 'codex' && snapshot.codex.activeAccountIdsByRuntime
        ? getActiveCodexAccountIdForRateLimitTarget(snapshot)
        : state.activeAccountId
    const activeUsage = getActiveProviderRateLimits(snapshot, provider)
    const activeSessionBar = getUsageBarState(activeUsage, 'session')
    const activeWeeklyBar = getUsageBarState(activeUsage, 'weekly')
    const resetCredit = provider === 'codex' ? getCodexResetCreditSummary(activeUsage, now) : null
    const Icon = provider === 'claude' ? ClaudeIcon : OpenAIIcon
    return (
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Icon size={14} />
          <Text style={styles.sectionHeading}>{title}</Text>
        </View>
        <View style={styles.card}>
          {/* System default row */}
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => selectAccount(provider, null)}
            disabled={busyAccountId !== null || resettingCodex || connState !== 'connected'}
          >
            <View style={styles.rowMain}>
              <Text style={styles.rowTitle}>System default</Text>
              <Text style={styles.rowSubtitle}>Use the agent's own login</Text>
              {/* Why: when system default is the active selection, activeUsage
                  holds the system-default login's rate limits — surface them
                  here so non-managed users still see their usage. */}
              {activeAccountId === null && hasActiveProviderUsage(activeUsage) ? (
                <View style={styles.usageRow}>
                  <UsageBar
                    label="5h"
                    usedPercent={activeSessionBar.usedPercent}
                    unavailable={activeSessionBar.unavailable}
                    loading={activeSessionBar.loading}
                    resetText={getWindowResetLabel(activeUsage, 'session', now)}
                  />
                  <UsageBar
                    label="7d"
                    usedPercent={activeWeeklyBar.usedPercent}
                    unavailable={activeWeeklyBar.unavailable}
                    loading={activeWeeklyBar.loading}
                    resetText={getWindowResetLabel(activeUsage, 'weekly', now)}
                  />
                </View>
              ) : null}
            </View>
            <View style={styles.rowTrailing}>
              {activeAccountId === null ? (
                <Check size={16} color={colors.accentBlue} />
              ) : busyAccountId === `${provider}:default` ? (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : null}
            </View>
          </Pressable>

          {state.accounts.map((account) => {
            const isActive = activeAccountId === account.id
            const inactiveEntry = !isActive
              ? getInactiveProviderUsage(snapshot, provider, account.id)
              : null
            const usage = isActive ? activeUsage : (inactiveEntry?.rateLimits ?? null)
            const isFetching =
              (isActive && usage?.status === 'fetching') ||
              (!isActive && inactiveEntry?.isFetching === true)
            const sessionBar = getUsageBarState(usage, 'session', isFetching)
            const weeklyBar = getUsageBarState(usage, 'weekly', isFetching)
            return (
              <View key={account.id}>
                <View style={styles.separator} />
                <Pressable
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  onPress={() => selectAccount(provider, account.id)}
                  disabled={
                    busyAccountId !== null ||
                    resettingCodex ||
                    connState !== 'connected' ||
                    isActive
                  }
                >
                  <View style={styles.rowMain}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {account.email}
                    </Text>
                    <View style={styles.usageRow}>
                      <UsageBar
                        label="5h"
                        usedPercent={sessionBar.usedPercent}
                        unavailable={sessionBar.unavailable}
                        loading={sessionBar.loading}
                        resetText={getWindowResetLabel(usage, 'session', now)}
                      />
                      <UsageBar
                        label="7d"
                        usedPercent={weeklyBar.usedPercent}
                        unavailable={weeklyBar.unavailable}
                        loading={weeklyBar.loading}
                        resetText={getWindowResetLabel(usage, 'weekly', now)}
                      />
                    </View>
                    {usage?.error ? (
                      <Text style={styles.errorText} numberOfLines={1}>
                        {usage.error}
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.rowTrailing}>
                    {isActive ? (
                      <Check size={16} color={colors.accentBlue} />
                    ) : busyAccountId === account.id ? (
                      <ActivityIndicator size="small" color={colors.textSecondary} />
                    ) : null}
                  </View>
                </Pressable>
              </View>
            )
          })}
          {resetCredit && codexResetSupported && resetScope && connState === 'connected' ? (
            <CodexResetCreditAction
              summary={resetCredit}
              scopeLabel={resetScopeLabel}
              busy={resettingCodex}
              disabled={resettingCodex || busyAccountId !== null || connState !== 'connected'}
              onPress={confirmCodexReset}
            />
          ) : null}
        </View>
      </View>
    )
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textPrimary} />
        </Pressable>
        <View style={styles.titleWrap}>
          <Text style={styles.heading}>Accounts</Text>
          {hostName ? (
            <Text style={styles.subheading} numberOfLines={1}>
              {hostName}
            </Text>
          ) : null}
        </View>
        <Pressable
          style={styles.iconButton}
          onPress={refresh}
          disabled={!client || refreshing || connState !== 'connected'}
        >
          {refreshing ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <RefreshCw size={18} color={colors.textSecondary} />
          )}
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + spacing.xl }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colors.textSecondary}
          />
        }
      >
        {connState !== 'connected' && !snapshot ? (
          <View style={styles.placeholder}>
            <ActivityIndicator color={colors.textSecondary} />
            <Text style={styles.placeholderText}>Connecting to {hostName || 'host'}…</Text>
          </View>
        ) : error && !snapshot ? (
          <View style={styles.placeholder}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : !snapshot ? (
          <View style={styles.placeholder}>
            <ActivityIndicator color={colors.textSecondary} />
            <Text style={styles.placeholderText}>Loading accounts…</Text>
          </View>
        ) : (
          <>
            <DeepSeekBalanceCard snapshot={snapshot} />
            {renderProviderSection('claude', 'Claude')}
            {renderProviderSection('codex', 'Codex')}
            <View style={styles.footerHint}>
              <User size={14} color={colors.textMuted} />
              <Text style={styles.footerHintText}>
                Add or re-authenticate accounts from desktop Settings → Accounts.
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}
