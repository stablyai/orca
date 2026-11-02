import { useEffect, useState, useCallback, useRef } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import { ChevronLeft, RefreshCw } from 'lucide-react-native'
import { loadHosts } from '../transport/host-store'
import { useHostClient } from '../transport/host-client-hooks'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useRouteHandoff } from '../navigation/route-handoff'
import { themedStyleSheet } from '../theme/themed-styles'
import {
  type AccountsSnapshot,
  decodeAccountsSnapshot,
  getActiveProviderRateLimits,
  getUsageBarState,
  getWindowResetLabel,
  hasActiveProviderUsage,
  UsageBar
} from '../components/AccountUsage'
import { useNow } from '../hooks/use-now'
import { AccountsSnapshotError } from '../components/accounts-snapshot'

function isAccountsSubscribeEvent(value: unknown): value is { type?: string; snapshot?: unknown } {
  return typeof value === 'object' && value !== null
}

export function MobileUsagePanelScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()

  const { client, state: connState } = useHostClient(hostId)
  const [hostName, setHostName] = useState<string>('')
  const [snapshot, setSnapshot] = useState<AccountsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [clockEnabled, setClockEnabled] = useState(false)

  const snapshotVersionRef = useRef(0)
  const refreshRequestRef = useRef(0)
  const acceptSnapshot = useCallback((nextSnapshot: AccountsSnapshot) => {
    snapshotVersionRef.current += 1
    setSnapshot(nextSnapshot)
    setError(null)
  }, [])

  useFocusEffect(
    useCallback(() => {
      setClockEnabled(true)
      return () => setClockEnabled(false)
    }, [])
  )
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
        setError(t('usagePanel.hostNotFound', 'Host not found'))
        return
      }
      setHostName(host.name)
    })
    return () => {
      stale = true
    }
  }, [hostId, t])

  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    const unsubscribe = client.subscribe('accounts.subscribe', null, (payload) => {
      if (!isAccountsSubscribeEvent(payload)) {
        return
      }
      const evt = payload
      if (evt.type === 'error') {
        void refresh()
        return
      }
      if (evt.type === 'ready' || evt.type === 'snapshot') {
        try {
          acceptSnapshot(decodeAccountsSnapshot(evt.snapshot))
        } catch {
          setSnapshot(null)
          setError(t('usagePanel.invalidSnapshot', 'Invalid usage snapshot from host'))
        }
      }
    })
    return unsubscribe
  }, [acceptSnapshot, client, connState, t])

  const refresh = useCallback(async () => {
    if (!client) {
      return
    }
    setRefreshing(true)
    const requestId = ++refreshRequestRef.current
    try {
      const res = await client.sendRequest('accounts.list')
      if (refreshRequestRef.current !== requestId) {
        return
      }
      if (res.ok) {
        acceptSnapshot(decodeAccountsSnapshot(res.result))
      } else {
        setError(res.error.message)
      }
    } catch (e) {
      if (refreshRequestRef.current === requestId) {
        if (e instanceof AccountsSnapshotError) {
          setSnapshot(null)
        }
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (refreshRequestRef.current === requestId) {
        setRefreshing(false)
      }
    }
  }, [acceptSnapshot, client, t])

  const renderProviderSection = (provider: 'claude' | 'codex', title: string) => {
    if (!snapshot) {
      return null
    }
    const usage = getActiveProviderRateLimits(snapshot, provider)
    if (
      !usage ||
      (!hasActiveProviderUsage(usage) &&
        usage.status !== 'fetching' &&
        usage.status !== 'idle' &&
        usage.status !== 'error')
    ) {
      return null
    }
    const sessionBar = getUsageBarState(usage, 'session')
    const weeklyBar = getUsageBarState(usage, 'weekly')
    return (
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionHeading}>{title}</Text>
        </View>
        <View style={styles.card}>
          <View style={styles.usageRow}>
            <UsageBar
              label={t('accounts.screen.sessionWindow', '5h')}
              usedPercent={sessionBar.usedPercent}
              unavailable={sessionBar.unavailable}
              loading={sessionBar.loading}
              resetText={getWindowResetLabel(usage, 'session', now)}
            />
            <UsageBar
              label={t('accounts.screen.weeklyWindow', '7d')}
              usedPercent={weeklyBar.usedPercent}
              unavailable={weeklyBar.unavailable}
              loading={weeklyBar.loading}
              resetText={getWindowResetLabel(usage, 'weekly', now)}
            />
          </View>
          {usage.error ? (
            <Text style={styles.errorText} numberOfLines={1}>
              {usage.error}
            </Text>
          ) : null}
        </View>
      </View>
    )
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.topRow}>
        <Pressable
          style={styles.backButton}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={t('common.back', 'Back')}
        >
          <ChevronLeft size={22} color={colors.textPrimary} />
        </Pressable>
        <View style={styles.titleWrap}>
          <Text style={styles.heading}>{t('usagePanel.title', 'Usage')}</Text>
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
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('usagePanel.refresh', 'Refresh usage')}
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
      >
        {!snapshot && (connState === 'auth-failed' || connState === 'disconnected') ? (
          <View style={styles.placeholder}>
            <Text style={styles.errorText}>
              {error ?? t('usagePanel.connectionFailed', 'Could not connect to host')}
            </Text>
          </View>
        ) : connState !== 'connected' && !snapshot ? (
          <View style={styles.placeholder}>
            <ActivityIndicator color={colors.textSecondary} />
            <Text style={styles.placeholderText}>
              {hostName
                ? t('usagePanel.connectingTo', 'Connecting to {{name}}…', { name: hostName })
                : t('usagePanel.connecting', 'Connecting to host…')}
            </Text>
          </View>
        ) : error && !snapshot ? (
          <View style={styles.placeholder}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : !snapshot ? (
          <View style={styles.placeholder}>
            <ActivityIndicator color={colors.textSecondary} />
            <Text style={styles.placeholderText}>{t('usagePanel.loading', 'Loading usage…')}</Text>
          </View>
        ) : (
          <>
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            {snapshot && (connState === 'auth-failed' || connState === 'disconnected') ? (
              <Text style={styles.errorText}>
                {t('usagePanel.disconnected', 'Disconnected from host')}
              </Text>
            ) : null}
            {renderProviderSection('claude', 'Claude')}
            {renderProviderSection('codex', 'Codex')}
            {(() => {
              const claudeUsage = getActiveProviderRateLimits(snapshot, 'claude')
              const codexUsage = getActiveProviderRateLimits(snapshot, 'codex')
              const claudeRenderable =
                !!claudeUsage &&
                (hasActiveProviderUsage(claudeUsage) ||
                  claudeUsage.status === 'fetching' ||
                  claudeUsage.status === 'idle' ||
                  claudeUsage.status === 'error')
              const codexRenderable =
                !!codexUsage &&
                (hasActiveProviderUsage(codexUsage) ||
                  codexUsage.status === 'fetching' ||
                  codexUsage.status === 'idle' ||
                  codexUsage.status === 'error')
              return !claudeRenderable && !codexRenderable
            })() ? (
              <View style={styles.placeholder}>
                <Text style={styles.placeholderText}>
                  {t('usagePanel.noUsage', 'No usage data available')}
                </Text>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = themedStyleSheet(() => ({
  container: { flex: 1, backgroundColor: colors.bgBase },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center'
  },
  titleWrap: { flex: 1 },
  heading: { fontSize: 20, fontWeight: '700', color: colors.textPrimary },
  subheading: { fontSize: 12, color: colors.textSecondary },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center'
  },
  scroll: { paddingHorizontal: spacing.lg, gap: spacing.md },
  section: { gap: spacing.sm },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  sectionHeading: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  card: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    padding: spacing.md,
    gap: spacing.sm
  },
  usageRow: { flexDirection: 'row', gap: spacing.sm },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm
  },
  placeholderText: { color: colors.textSecondary },
  errorText: { color: colors.statusRed }
}))
