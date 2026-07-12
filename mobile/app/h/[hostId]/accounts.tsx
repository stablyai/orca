import { useEffect, useState, useCallback } from 'react'
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
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router'
import { ChevronLeft, Check, RefreshCw, User, Gauge } from 'lucide-react-native'
import { loadHosts } from '../../../src/transport/host-store'
import { useHostClient } from '../../../src/transport/client-context'
import type { RpcSuccess } from '../../../src/transport/types'
import { colors, spacing } from '../../../src/theme/mobile-theme'
import { styles } from './accounts-screen-styles'
import { ClaudeIcon, OpenAIIcon } from '../../../src/components/AgentIcons'
import { loadVisibleUsageProviders } from '../../../src/storage/preferences'
import {
  type AccountsSnapshot,
  type ProviderKey,
  type UsageProviderKey,
  type UsageProviderDescriptor,
  USAGE_PROVIDERS,
  DEFAULT_VISIBLE_USAGE_PROVIDERS,
  getActiveProviderRateLimits,
  getInactiveProviderUsage,
  getProviderUsageWindows,
  getUsageBarState,
  hasActiveProviderUsage,
  UsageBar,
  UsageWindowBars
} from '../../../src/components/AccountUsage'

export default function AccountsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()

  // Why: shared client per host. See docs/mobile-shared-client-per-host.md.
  const { client, state: connState } = useHostClient(hostId)
  const [hostName, setHostName] = useState<string>('')
  const [snapshot, setSnapshot] = useState<AccountsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null)
  const [visibleProviders, setVisibleProviders] = useState<Set<UsageProviderKey>>(
    () => new Set(DEFAULT_VISIBLE_USAGE_PROVIDERS)
  )

  // Why: reload on focus so a change made in Settings → Account usage is
  // reflected when the user navigates back — the screen stays mounted and
  // updates in place (mirrors how the terminal picks up Settings → Terminal).
  useFocusEffect(
    useCallback(() => {
      let active = true
      void loadVisibleUsageProviders().then((set) => {
        if (active) {
          setVisibleProviders(set)
        }
      })
      return () => {
        active = false
      }
    }, [])
  )

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
    const unsubscribe = client.subscribe('accounts.subscribe', null, (payload) => {
      if (!payload || typeof payload !== 'object') {
        return
      }
      const evt = payload as { type?: string; snapshot?: AccountsSnapshot }
      if ((evt.type === 'ready' || evt.type === 'snapshot') && evt.snapshot) {
        setSnapshot(evt.snapshot)
        setError(null)
      }
    })
    return unsubscribe
  }, [client, connState])

  const refresh = useCallback(async () => {
    if (!client) {
      return
    }
    setRefreshing(true)
    try {
      const res = await client.sendRequest('accounts.list')
      if (res.ok) {
        setSnapshot((res as RpcSuccess).result as AccountsSnapshot)
        setError(null)
      } else {
        setError(res.error.message)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRefreshing(false)
    }
  }, [client])

  const selectAccount = useCallback(
    async (provider: ProviderKey, accountId: string | null) => {
      if (!client) {
        return
      }
      setBusyAccountId(accountId ?? `${provider}:default`)
      const method = provider === 'claude' ? 'accounts.selectClaude' : 'accounts.selectCodex'
      try {
        const res = await client.sendRequest(method, { accountId })
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
    [client, refresh]
  )

  const renderProviderSection = (provider: ProviderKey, title: string) => {
    if (!snapshot) {
      return null
    }
    const state = provider === 'claude' ? snapshot.claude : snapshot.codex
    const activeUsage = getActiveProviderRateLimits(snapshot, provider)
    const activeSessionBar = getUsageBarState(activeUsage, 'session')
    const activeWeeklyBar = getUsageBarState(activeUsage, 'weekly')
    const Icon = provider === 'claude' ? ClaudeIcon : OpenAIIcon
    return (
      <View style={styles.section} key={provider}>
        <View style={styles.sectionHeader}>
          <Icon size={14} />
          <Text style={styles.sectionHeading}>{title}</Text>
        </View>
        <View style={styles.card}>
          {/* System default row */}
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => selectAccount(provider, null)}
            disabled={busyAccountId !== null || connState !== 'connected'}
          >
            <View style={styles.rowMain}>
              <Text style={styles.rowTitle}>System default</Text>
              <Text style={styles.rowSubtitle}>Use the agent's own login</Text>
              {/* Why: when system default is the active selection, activeUsage
                  holds the system-default login's rate limits — surface them
                  here so non-managed users still see their usage. */}
              {state.activeAccountId === null && hasActiveProviderUsage(activeUsage) ? (
                <View style={styles.usageRow}>
                  <UsageBar
                    label="5h"
                    usedPercent={activeSessionBar.usedPercent}
                    unavailable={activeSessionBar.unavailable}
                    loading={activeSessionBar.loading}
                  />
                  <UsageBar
                    label="7d"
                    usedPercent={activeWeeklyBar.usedPercent}
                    unavailable={activeWeeklyBar.unavailable}
                    loading={activeWeeklyBar.loading}
                  />
                </View>
              ) : null}
            </View>
            <View style={styles.rowTrailing}>
              {state.activeAccountId === null ? (
                <Check size={16} color={colors.accentBlue} />
              ) : busyAccountId === `${provider}:default` ? (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : null}
            </View>
          </Pressable>

          {state.accounts.map((account) => {
            const isActive = state.activeAccountId === account.id
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
                  disabled={busyAccountId !== null || connState !== 'connected' || isActive}
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
                      />
                      <UsageBar
                        label="7d"
                        usedPercent={weeklyBar.usedPercent}
                        unavailable={weeklyBar.unavailable}
                        loading={weeklyBar.loading}
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
        </View>
      </View>
    )
  }

  // Why: display-only providers (Gemini/OpenCode Go/Kimi/MiniMax/Grok) have no
  // Orca-managed accounts and no interactive switching, so the section is a
  // non-pressable card that just surfaces the system-default target's usage.
  // Rendered windows come from getProviderUsageWindows so Gemini buckets and
  // OpenCode Go monthly show instead of two hardcoded 5h/7d bars.
  const renderDisplayProviderSection = (descriptor: UsageProviderDescriptor) => {
    if (!snapshot) {
      return null
    }
    const usage = getActiveProviderRateLimits(snapshot, descriptor.id)
    // Why: show a configured provider that is still loading or transiently
    // failing (spinner / error copy below); only hide a genuinely
    // unconfigured provider (no data and not fetching/error).
    const renderable =
      hasActiveProviderUsage(usage) || usage?.status === 'fetching' || usage?.status === 'error'
    if (!renderable) {
      return null
    }
    const windows = getProviderUsageWindows(usage)
    const fetching = usage?.status === 'fetching'
    return (
      <View style={styles.section} key={descriptor.id}>
        <View style={styles.sectionHeader}>
          <Gauge size={14} color={colors.textMuted} />
          <Text style={styles.sectionHeading}>{descriptor.label}</Text>
        </View>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.rowMain}>
              <Text style={styles.rowTitle}>System default</Text>
              <UsageWindowBars windows={windows} fetching={fetching} />
              {usage?.error ? (
                <Text style={styles.errorText} numberOfLines={1}>
                  {usage.error}
                </Text>
              ) : null}
            </View>
          </View>
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
            {USAGE_PROVIDERS.filter((p) => visibleProviders.has(p.id)).map((p) =>
              p.id === 'claude' || p.id === 'codex'
                ? renderProviderSection(p.id, p.label)
                : renderDisplayProviderSection(p)
            )}
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
