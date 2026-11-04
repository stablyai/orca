import { useEffect, useState, useCallback } from 'react'
import { View, Text, ScrollView, ActivityIndicator } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import { ChevronLeft, RefreshCw, User } from 'lucide-react-native'
import { loadHosts, peekHosts } from '../transport/host-store'
import { useForceReconnect, useHostClient } from '../transport/host-client-hooks'
import { MobileAccountsLoadState } from './MobileAccountsLoadState'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-accounts-screen-styles'
import { useNow } from '../hooks/use-now'
import { ClaudeIcon, OpenAIIcon } from '../components/AgentIcons'
import { AccountsSnapshotError, decodeAccountsSnapshot } from '../components/accounts-snapshot'
import {
  type AccountsSnapshot,
  type ProviderKey,
  getActiveProviderRateLimits,
  getInactiveProviderUsage,
  getUsageBarState,
  getWindowResetLabel,
  hasActiveProviderUsage,
  UsageBar
} from '../components/AccountUsage'
import {
  getActiveCodexAccountIdForRateLimitTarget,
  getCodexResetCreditSummary
} from '../components/codex-reset-credit'
import { CodexResetCreditAction } from '../components/CodexResetCreditAction'
import { useCodexResetCreditAction } from '../components/use-codex-reset-credit-action'
import { ConfirmModal } from '../components/ConfirmModal'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { ListGroup, SectionHeader, ListRow } from '../components/list/ListGroup'
import { useRouteHandoff } from '../navigation/route-handoff'

type AccountsNotice = { title: string; message: string }

// Use page ConfirmModal because RN Web Alert.alert is a no-op; Back must hand off to shell’s native stack.
export function MobileAccountsScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()

  // Why: shared client per host. See docs/mobile-shared-client-per-host.md.
  const { client, state: connState } = useHostClient(hostId)
  const forceReconnect = useForceReconnect()
  // Seed from the last host read so the subtitle is there on the first frame.
  const [hostName, setHostName] = useState(
    () => peekHosts()?.find((host) => host.id === hostId)?.name ?? ''
  )
  const [snapshot, setSnapshot] = useState<AccountsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null)
  const [clockEnabled, setClockEnabled] = useState(false)
  const [notice, setNotice] = useState<AccountsNotice | null>(null)

  const acceptSnapshot = useCallback((nextSnapshot: AccountsSnapshot) => {
    setSnapshot(nextSnapshot)
    setError(null)
  }, [])
  const rejectInvalidSnapshot = useCallback(() => {
    // Fail closed on unrecognized snapshot: stale data can expose finite reset for wrong account.
    setSnapshot(null)
    setError(t('accounts.screen.invalidSnapshot', 'Invalid accounts snapshot from host'))
  }, [t])
  const {
    supported: codexResetSupported,
    resetting: resettingCodex,
    resetScope,
    scopeLabel: resetScopeLabel,
    confirmReset: confirmCodexReset,
    confirmation: codexResetConfirmation,
    acceptReset: acceptCodexReset,
    cancelReset: cancelCodexReset
  } = useCodexResetCreditAction({
    client,
    connected: connState === 'connected',
    snapshot,
    accountMutationBusy: busyAccountId !== null,
    onSnapshot: acceptSnapshot,
    onNotice: setNotice
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
        setError(t('accounts.screen.hostNotFound', 'Host not found'))
        return
      }
      setHostName(host.name)
    })
    return () => {
      stale = true
    }
  }, [hostId, t])

  const refresh = useCallback(async () => {
    if (!client) {
      return
    }
    setRefreshing(true)
    try {
      const res = await client.sendRequest('accounts.list')
      if (res.ok) {
        acceptSnapshot(decodeAccountsSnapshot(res.result))
      } else {
        setError(res.error.message)
      }
    } catch (e) {
      if (e instanceof AccountsSnapshotError) {
        rejectInvalidSnapshot()
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setRefreshing(false)
    }
  }, [acceptSnapshot, client, rejectInvalidSnapshot])

  // Stream desktop poll/account-switch updates, falling back to one-shot accounts.list on subscription error.
  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    const unsubscribe = client.subscribe('accounts.subscribe', null, (payload) => {
      if (!payload || typeof payload !== 'object') {
        return
      }
      const evt = payload as { type?: string; snapshot?: unknown }
      if (evt.type === 'error') {
        void refresh()
        return
      }
      if (evt.type === 'ready' || evt.type === 'snapshot') {
        try {
          acceptSnapshot(decodeAccountsSnapshot(evt.snapshot))
        } catch {
          rejectInvalidSnapshot()
        }
      }
    })
    return unsubscribe
  }, [acceptSnapshot, client, connState, refresh, rejectInvalidSnapshot])

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
      const title = t('accounts.screen.switchFailed', 'Could not switch account')
      try {
        // Use distinct WSL-targeted RPC: older hosts silently strip unknown fields, so version skew must fail before mutation.
        const params =
          codexTarget?.runtime === 'wsl' ? { accountId, target: codexTarget } : { accountId }
        const res = await client.sendRequest(method, params)
        if (!res.ok) {
          setNotice({ title, message: res.error.message })
        } else {
          // Refresh optimistically so disconnected subscription cannot delay feedback.
          await refresh()
        }
      } catch (e) {
        setNotice({ title, message: e instanceof Error ? e.message : String(e) })
      } finally {
        setBusyAccountId(null)
      }
    },
    [client, refresh, snapshot, t]
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
    const switchBlocked = busyAccountId !== null || resettingCodex || connState !== 'connected'
    const spinner = <ActivityIndicator size="small" color={colors.textSecondary} />
    return (
      <View>
        <SectionHeader title={title} icon={<Icon size={14} />} first={provider === 'claude'} />
        <ListGroup style={styles.group}>
          {/* A blocked row drops its press instead of dimming, so the picked one keeps full contrast. */}
          <ListRow
            key="default"
            title={t('accounts.screen.default', 'System default')}
            subtitle={t('accounts.screen.agentLogin', "Use the agent's own login")}
            detail={
              // Show system-default login usage for users without managed accounts.
              activeAccountId === null && hasActiveProviderUsage(activeUsage) ? (
                <View style={styles.usageRow}>
                  <UsageBar
                    label={t('accounts.screen.sessionWindow', '5h')}
                    usedPercent={activeSessionBar.usedPercent}
                    unavailable={activeSessionBar.unavailable}
                    loading={activeSessionBar.loading}
                    resetText={getWindowResetLabel(activeUsage, 'session', now)}
                  />
                  <UsageBar
                    label={t('accounts.screen.weeklyWindow', '7d')}
                    usedPercent={activeWeeklyBar.usedPercent}
                    unavailable={activeWeeklyBar.unavailable}
                    loading={activeWeeklyBar.loading}
                    resetText={getWindowResetLabel(activeUsage, 'weekly', now)}
                  />
                </View>
              ) : undefined
            }
            accessory={busyAccountId === `${provider}:default` ? spinner : undefined}
            selected={activeAccountId === null}
            onPress={switchBlocked ? undefined : () => void selectAccount(provider, null)}
          />
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
              <ListRow
                key={account.id}
                title={account.email}
                detail={
                  <>
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
                    {usage?.error ? (
                      <Text style={styles.errorText} numberOfLines={1}>
                        {usage.error}
                      </Text>
                    ) : null}
                  </>
                }
                accessory={busyAccountId === account.id ? spinner : undefined}
                selected={isActive}
                onPress={
                  switchBlocked || isActive
                    ? undefined
                    : () => void selectAccount(provider, account.id)
                }
              />
            )
          })}
          {resetCredit && codexResetSupported && resetScope && connState === 'connected' ? (
            <CodexResetCreditAction
              key="codex-reset"
              summary={resetCredit}
              scopeLabel={resetScopeLabel}
              busy={resettingCodex}
              disabled={resettingCodex || busyAccountId !== null || connState !== 'connected'}
              onPress={confirmCodexReset}
            />
          ) : null}
        </ListGroup>
      </View>
    )
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <NavBar
        leading={
          <NavBarButton
            icon={ChevronLeft}
            onPress={() => router.back()}
            accessibilityLabel={t('common.back', 'Back')}
          />
        }
        title={t('accounts.screen.title', 'Accounts')}
        subtitle={hostName || undefined}
        trailing={
          <NavBarButton
            icon={refreshing ? RefreshingIcon : RefreshCw}
            onPress={() => void refresh()}
            disabled={!client || refreshing || connState !== 'connected'}
            accessibilityLabel={t('accounts.screen.refreshAccounts', 'Refresh accounts')}
          />
        }
      />

      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          !snapshot && { flexGrow: 1 },
          { paddingBottom: insets.bottom + spacing.xl }
        ]}
      >
        {!snapshot ? (
          <MobileAccountsLoadState
            connState={connState}
            hostName={hostName}
            error={error}
            onRetry={() => void refresh()}
            onReconnect={hostId && forceReconnect ? () => void forceReconnect(hostId) : null}
            onRepair={() => router.push('/pair-scan')}
          />
        ) : (
          <>
            {renderProviderSection('claude', 'Claude')}
            {renderProviderSection('codex', 'Codex')}
            <View style={styles.footerHint}>
              <User size={14} color={colors.textMuted} />
              <Text style={styles.footerHintText}>
                {t(
                  'accounts.screen.manageAccountsHint',
                  'Add or re-authenticate accounts from desktop Settings → Accounts.'
                )}
              </Text>
            </View>
          </>
        )}
      </ScrollView>
      <ConfirmModal
        visible={codexResetConfirmation !== null}
        title={codexResetConfirmation?.title ?? ''}
        message={codexResetConfirmation?.message}
        confirmLabel={t('accounts.screen.useReset', 'Use reset')}
        onConfirm={acceptCodexReset}
        onCancel={cancelCodexReset}
      />
      <ConfirmModal
        visible={notice !== null}
        title={notice?.title ?? ''}
        message={notice?.message}
        confirmLabel={t('common.ok', 'OK')}
        cancelLabel={null}
        onCancel={() => setNotice(null)}
      />
    </SafeAreaView>
  )
}

function RefreshingIcon({ color }: { color?: string }) {
  return <ActivityIndicator size="small" color={color} />
}
