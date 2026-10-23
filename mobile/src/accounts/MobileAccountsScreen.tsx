import { useEffect, useState, useCallback } from 'react'
import { View, Text, ScrollView } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import { CircleAlert, CloudOff, KeyRound, User } from 'lucide-react-native'
import { loadHosts } from '../transport/host-store'
import { useForceReconnect, useHostClient } from '../transport/host-client-hooks'
import { connectionRetryAction } from '../transport/connection-retry-action'
import { colors, spacing } from '../theme/mobile-theme'
import { NavBar } from '../components/ui/NavBar'
import { ListGroup } from '../components/ui/ListGroup'
import { StateView } from '../components/ui/StateView'
import { Banner } from '../components/ui/Banner'
import { MobileNavRefreshButton } from '../components/MobileNavRefreshButton'
import { styles } from './mobile-accounts-screen-styles'
import { AccountRow, readableAccountsError } from './mobile-account-row'
import { useNow } from '../hooks/use-now'
import { ClaudeIcon, OpenAIIcon } from '../components/AgentIcons'
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
} from '../components/AccountUsage'
import {
  getActiveCodexAccountIdForRateLimitTarget,
  getCodexResetCreditSummary
} from '../components/codex-reset-credit'
import { CodexResetCreditAction } from '../components/CodexResetCreditAction'
import { useCodexResetCreditAction } from '../components/use-codex-reset-credit-action'
import { ConfirmModal } from '../components/ConfirmModal'
import { useRouteHandoff } from '../navigation/route-handoff'

type AccountsNotice = { title: string; message: string }

/**
 * The host's agent accounts. Drawn by the page, so prompts are `ConfirmModal`s rather than
 * `Alert.alert` (a no-op on React Native Web) and Back is the handoff's, which pops the shell.
 */
export function MobileAccountsScreen() {
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()

  // Why: shared client per host. See docs/mobile-shared-client-per-host.md.
  const { client, state: connState } = useHostClient(hostId)
  const forceReconnect = useForceReconnect()
  const [scrolled, setScrolled] = useState(false)
  const [hostName, setHostName] = useState<string>('')
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
    // Why: a stale snapshot can expose a finite reset action for the wrong
    // account; fail closed if a host sends a shape this mobile cannot prove.
    setSnapshot(null)
    setError('Invalid accounts snapshot from host')
  }, [])
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
        setError('This desktop is no longer paired.')
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
      const evt = payload as { type?: string; snapshot?: unknown }
      if (evt.type === 'ready' || evt.type === 'snapshot') {
        try {
          acceptSnapshot(decodeAccountsSnapshot(evt.snapshot))
        } catch {
          rejectInvalidSnapshot()
        }
      }
    })
    return unsubscribe
  }, [acceptSnapshot, client, connState, rejectInvalidSnapshot])

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
      if (e instanceof Error && e.message === 'Invalid accounts snapshot from host') {
        rejectInvalidSnapshot()
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setRefreshing(false)
    }
  }, [acceptSnapshot, client, rejectInvalidSnapshot])

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
          setNotice({ title: 'Could not switch account', message: res.error.message })
        } else {
          // Why: optimistic refresh — the streaming subscription will also
          // emit, but a one-shot keeps the UI responsive even if the stream
          // is temporarily disconnected.
          await refresh()
        }
      } catch (e) {
        setNotice({
          title: 'Could not switch account',
          message: e instanceof Error ? e.message : String(e)
        })
      } finally {
        setBusyAccountId(null)
      }
    },
    [client, refresh, snapshot]
  )

  const connected = connState === 'connected'
  const interactionBlocked = busyAccountId !== null || resettingCodex || !connected

  const renderUsage = (
    usage: Parameters<typeof getWindowResetLabel>[0],
    sessionBar: ReturnType<typeof getUsageBarState>,
    weeklyBar: ReturnType<typeof getUsageBarState>
  ) => (
    <View style={styles.usageStack}>
      <UsageBar
        layout="stacked"
        label="5h"
        usedPercent={sessionBar.usedPercent}
        unavailable={sessionBar.unavailable}
        loading={sessionBar.loading}
        resetText={getWindowResetLabel(usage, 'session', now)}
      />
      <UsageBar
        layout="stacked"
        label="7d"
        usedPercent={weeklyBar.usedPercent}
        unavailable={weeklyBar.unavailable}
        loading={weeklyBar.loading}
        resetText={getWindowResetLabel(usage, 'weekly', now)}
      />
    </View>
  )

  const renderProviderSection = (provider: ProviderKey, title: string, first: boolean) => {
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
    const defaultActive = activeAccountId === null
    return (
      <View>
        <View style={[styles.sectionHeader, first && styles.sectionHeaderFirst]}>
          <Icon size={14} />
          <Text style={styles.sectionHeading} accessibilityRole="header">
            {title}
          </Text>
        </View>
        <ListGroup>
          <AccountRow
            key="default"
            title="System default"
            subtitle="Uses the agent’s own sign-in."
            active={defaultActive}
            busy={busyAccountId === `${provider}:default`}
            disabled={interactionBlocked}
            onPress={() => selectAccount(provider, null)}
          >
            {/* Why: when system default is the active selection, activeUsage
                holds the system-default login's rate limits — surface them
                here so non-managed users still see their usage. */}
            {defaultActive && hasActiveProviderUsage(activeUsage)
              ? renderUsage(activeUsage, activeSessionBar, activeWeeklyBar)
              : null}
          </AccountRow>
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
              <AccountRow
                key={account.id}
                title={account.email}
                active={isActive}
                busy={busyAccountId === account.id}
                disabled={interactionBlocked}
                onPress={() => selectAccount(provider, account.id)}
              >
                {renderUsage(usage, sessionBar, weeklyBar)}
                {usage?.error ? (
                  <Text style={styles.errorText} numberOfLines={2}>
                    {usage.error}
                  </Text>
                ) : null}
              </AccountRow>
            )
          })}
          {resetCredit && codexResetSupported && resetScope && connected ? (
            <CodexResetCreditAction
              key="codex-reset"
              summary={resetCredit}
              scopeLabel={resetScopeLabel}
              busy={resettingCodex}
              disabled={resettingCodex || busyAccountId !== null || !connected}
              onPress={confirmCodexReset}
            />
          ) : null}
        </ListGroup>
      </View>
    )
  }

  const desktopName = hostName || 'Your desktop'
  const reconnect = connectionRetryAction({
    hostId,
    needsReconnect: true,
    forceReconnect,
    reload: () => void refresh()
  })
  const body = snapshot ? (
    <>
      {!connected ? (
        <View style={styles.banner}>
          <Banner
            tone="warning"
            message={`${desktopName} is offline. These are the last accounts it sent; switching waits until it’s back.`}
          />
        </View>
      ) : error ? (
        <View style={styles.banner}>
          <Banner
            tone="error"
            title="Couldn’t refresh accounts"
            message={readableAccountsError(error)}
            onDismiss={() => setError(null)}
          />
        </View>
      ) : null}
      {renderProviderSection('claude', 'Claude', true)}
      {renderProviderSection('codex', 'Codex', false)}
      <View style={styles.footerHint}>
        <User size={14} color={colors.textMuted} style={styles.footerIcon} />
        <Text style={styles.footerHintText}>
          Add or re-authenticate accounts from desktop Settings → Accounts.
        </Text>
      </View>
    </>
  ) : connState === 'auth-failed' ? (
    <StateView
      icon={KeyRound}
      title="Couldn’t sign in to your desktop"
      message="Try reconnecting. If it keeps failing, pair this phone again from desktop."
      primary={reconnect ? { label: 'Retry', onPress: reconnect } : undefined}
    />
  ) : connState === 'disconnected' || connState === 'reconnecting' ? (
    <StateView
      icon={CloudOff}
      title="Waiting for desktop"
      message={`${desktopName} is offline. Accounts load once it reconnects.`}
      primary={reconnect ? { label: 'Retry', onPress: reconnect } : undefined}
    />
  ) : !connected ? (
    <StateView loading title={`Connecting to ${hostName || 'desktop'}…`} />
  ) : error ? (
    <StateView
      icon={CircleAlert}
      title="Couldn’t load accounts"
      message={readableAccountsError(error)}
      primary={{ label: 'Retry', onPress: () => void refresh(), busy: refreshing }}
    />
  ) : (
    <StateView loading title="Loading accounts…" />
  )

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <NavBar
        title="Accounts"
        subtitle={hostName || undefined}
        onBack={() => router.back()}
        scrolled={scrolled}
        trailing={
          <MobileNavRefreshButton
            busy={refreshing}
            onPress={() => void refresh()}
            disabled={!client || !connected}
            accessibilityLabel="Refresh accounts"
          />
        }
      />

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + spacing.xl }]}
        onScroll={(event) => setScrolled(event.nativeEvent.contentOffset.y > 0)}
        scrollEventThrottle={32}
      >
        {body}
      </ScrollView>
      <ConfirmModal
        visible={codexResetConfirmation !== null}
        title={codexResetConfirmation?.title ?? ''}
        message={codexResetConfirmation?.message}
        confirmLabel="Use reset"
        onConfirm={acceptCodexReset}
        onCancel={cancelCodexReset}
      />
      <ConfirmModal
        visible={notice !== null}
        title={notice?.title ?? ''}
        message={notice?.message}
        confirmLabel="OK"
        cancelLabel={null}
        onCancel={() => setNotice(null)}
      />
    </SafeAreaView>
  )
}
