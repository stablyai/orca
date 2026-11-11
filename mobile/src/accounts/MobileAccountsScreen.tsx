import { useEffect, useState, useCallback } from 'react'
import { View, Text, ScrollView, ActivityIndicator } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import { ChevronLeft, RefreshCw, User } from 'lucide-react-native'
import { loadHosts, peekHosts } from '../host-catalog/host-store'
import { useForceReconnect, useHostClient } from '../transport/connection/host-client-hooks'
import { useHostConnectionInputs } from '../transport/connection/client-context-connection-metrics'
import { classifyConnection, isConnectionOutage } from '../transport/connection/connection-health'
import { HostOfflineBanner, useHostOfflineBanner } from '../components/HostOfflineBanner'
import { useRefreshHint } from '../query/refresh-hint'
import { MobileAccountsLoadState } from './MobileAccountsLoadState'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-accounts-screen-styles'
import { useNow } from '../hooks/use-now'
import { ClaudeIcon, OpenAIIcon } from '../components/AgentIcons'
import './usage/UsageBar'
import {
  type ProviderKey,
  getActiveProviderRateLimits,
  getInactiveProviderUsage,
  getOtherUsageProviders,
  hasActiveProviderUsage
} from './usage/usage-selectors'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { getProviderDisplayName } from '../../../src/shared/usage-provider-windows'
import { ProviderUsageWindows } from './ProviderUsageWindows'
import {
  getActiveCodexAccountIdForRateLimitTarget,
  getCodexResetCreditSummary
} from './usage/codex-reset-credit'
import { CodexResetCreditAction } from './usage/CodexResetCreditAction'
import { useCodexResetCreditAction } from './usage/use-codex-reset-credit-action'
import { ConfirmModal } from '../components/ConfirmModal'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { ListGroup, SectionHeader, ListRow } from '../components/list/ListGroup'
import { useRouteHandoff } from '../navigation/route-handoff'
import { useMobileAccountsSnapshot } from './use-mobile-accounts-snapshot'

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
  const connectionInputs = useHostConnectionInputs(hostId)
  // Seed from the last host read so the subtitle is there on the first frame.
  const [hostName, setHostName] = useState(
    () => peekHosts()?.find((host) => host.id === hostId)?.name ?? ''
  )
  const [hostError, setHostError] = useState<string | null>(null)
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null)
  const [clockEnabled, setClockEnabled] = useState(false)
  const [notice, setNotice] = useState<AccountsNotice | null>(null)

  const accounts = useMobileAccountsSnapshot({
    hostId,
    client,
    connState,
    lastConnectedAt: connectionInputs.lastConnectedAt
  })
  const { snapshot, live, refresh, refreshing, acceptSnapshot } = accounts
  const error = accounts.error ?? hostError
  // Stored accounts stay up while connecting or offline; re-pair and a failed read on a live connection say so instead.
  const showsAccounts =
    snapshot !== null &&
    (live || (connState !== 'auth-failed' && !(connState === 'connected' && error)))
  const offlineBanner = useHostOfflineBanner({
    client,
    connState,
    lastConnectedAt: connectionInputs.lastConnectedAt,
    outage: isConnectionOutage(classifyConnection({ state: connState, ...connectionInputs })),
    forceReconnect: hostId && forceReconnect ? () => void forceReconnect(hostId) : null,
    hasData: showsAccounts,
    asOf: accounts.readAt
  })
  // Stored accounts wait on the stream's first answer for their usage.
  const showRefreshLine = useRefreshHint(showsAccounts && !live && offlineBanner === null)
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
        setHostError(t('accounts.screen.hostNotFound', 'Host not found'))
        return
      }
      setHostName(host.name)
    })
    return () => {
      stale = true
    }
  }, [hostId, t])

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

  const renderProviderSection = (provider: ProviderKey) => {
    if (!snapshot) {
      return null
    }
    const state = provider === 'claude' ? snapshot.claude : snapshot.codex
    const activeAccountId =
      provider === 'codex' && snapshot.codex.activeAccountIdsByRuntime
        ? getActiveCodexAccountIdForRateLimitTarget(snapshot)
        : state.activeAccountId
    const activeUsage = getActiveProviderRateLimits(snapshot, provider)
    const resetCredit = provider === 'codex' ? getCodexResetCreditSummary(activeUsage, now) : null
    const Icon = provider === 'claude' ? ClaudeIcon : OpenAIIcon
    // Stored rows may name a selection or Codex target the desktop has since changed.
    const switchBlocked = busyAccountId !== null || resettingCodex || !live
    const spinner = <ActivityIndicator size="small" color={colors.textSecondary} />
    return (
      <View>
        <SectionHeader
          title={getProviderDisplayName(provider)}
          icon={<Icon size={14} />}
          first={provider === 'claude'}
        />
        <ListGroup style={styles.group}>
          {/* A blocked row drops its press instead of dimming, so the picked one keeps full contrast. */}
          <ListRow
            key="default"
            title={t('accounts.screen.default', 'System default')}
            subtitle={t('accounts.screen.agentLogin', "Use the agent's own login")}
            detail={
              // Show system-default login usage for users without managed accounts.
              activeAccountId === null && hasActiveProviderUsage(activeUsage) ? (
                <ProviderUsageWindows limits={activeUsage} now={now} showEmptyWindows />
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
            return (
              <ListRow
                key={account.id}
                title={account.email}
                detail={
                  <>
                    <ProviderUsageWindows
                      limits={usage}
                      now={now}
                      isFetching={isFetching}
                      showEmptyWindows
                    />
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

  // Every other provider desktop shows usage for; usage only, since accounts are managed on desktop.
  const renderOtherProviders = () => {
    const providers = snapshot ? getOtherUsageProviders(snapshot) : []
    if (providers.length === 0) {
      return null
    }
    return (
      <View>
        <SectionHeader title={t('accounts.screen.otherAgents', 'Other agents')} />
        <ListGroup style={styles.group}>
          {providers.map((limits) => (
            <ListRow
              key={limits.provider}
              title={getProviderDisplayName(limits.provider)}
              leading={<MobileAgentIcon agentId={limits.provider} size={16} />}
              detail={
                <>
                  <ProviderUsageWindows limits={limits} now={now} />
                  {limits.error ? (
                    <Text style={styles.errorText} numberOfLines={1}>
                      {limits.error}
                    </Text>
                  ) : null}
                </>
              }
            />
          ))}
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
        refreshing={showRefreshLine}
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
          !showsAccounts && { flexGrow: 1 },
          { paddingBottom: insets.bottom + spacing.xl }
        ]}
      >
        {!showsAccounts ? (
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
            {offlineBanner ? (
              <View style={styles.offlineBanner}>
                <HostOfflineBanner
                  hostName={hostName}
                  offline={offlineBanner.offline}
                  asOf={offlineBanner.asOf}
                  onRetry={offlineBanner.retry}
                />
              </View>
            ) : null}
            {renderProviderSection('claude')}
            {renderProviderSection('codex')}
            {renderOtherProviders()}
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
