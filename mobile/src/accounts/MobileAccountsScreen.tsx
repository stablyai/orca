import { useEffect, useState, useCallback, useRef } from 'react'
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
import {
  AccountsSnapshotError,
  decodeAccountsSnapshot,
  type AccountsSnapshot
} from '../components/accounts-snapshot'
import type { ProviderKey } from '../components/account-usage-state'
import { useCodexResetCreditAction } from '../components/use-codex-reset-credit-action'
import { ConfirmModal } from '../components/ConfirmModal'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { useRouteHandoff } from '../navigation/route-handoff'
import { ClaudeCodexAccountSections } from './claude-codex-account-section'
import { AntigravityAccountSection } from './antigravity-account-section'
import {
  ManagedDataAccountSection,
  managedDataBusyId,
  type ManagedDataProvider
} from './managed-data-account-section'
import { ProviderUsageSection } from './provider-usage-section'

type AccountsNotice = { title: string; message: string }

// Use page ConfirmModal because RN Web Alert.alert is a no-op; Back must hand off to shell’s native stack.
export function MobileAccountsScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const currentHost = useRef({ hostId })
  if (currentHost.current.hostId !== hostId) {
    currentHost.current = { hostId }
  }
  const hostScope = currentHost.current

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
  const [providerAccountReload, setProviderAccountReload] = useState(0)

  useEffect(() => {
    setSnapshot(null)
    setError(null)
    setRefreshing(false)
    setBusyAccountId(null)
    setNotice(null)
  }, [hostId])

  const acceptSnapshot = useCallback(
    (nextSnapshot: AccountsSnapshot) => {
      if (currentHost.current === hostScope) {
        setSnapshot(nextSnapshot)
        setError(null)
      }
    },
    [hostScope]
  )
  const rejectInvalidSnapshot = useCallback(() => {
    if (currentHost.current !== hostScope) {
      return
    }
    // Fail closed on unrecognized snapshot: stale data can expose finite reset for wrong account.
    setSnapshot(null)
    setError(t('accounts.screen.invalidSnapshot', 'Invalid accounts snapshot from host'))
  }, [hostScope, t])
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
    if (!client || currentHost.current !== hostScope) {
      return
    }
    setRefreshing(true)
    setProviderAccountReload((value) => value + 1)
    try {
      const res = await client.sendRequest('accounts.list')
      if (currentHost.current !== hostScope) {
        return
      }
      if (res.ok) {
        acceptSnapshot(decodeAccountsSnapshot(res.result))
      } else {
        setError(res.error.message)
      }
    } catch (e) {
      if (currentHost.current !== hostScope) {
        return
      }
      if (e instanceof AccountsSnapshotError) {
        rejectInvalidSnapshot()
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (currentHost.current === hostScope) {
        setRefreshing(false)
      }
    }
  }, [acceptSnapshot, client, hostScope, rejectInvalidSnapshot])

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

  const selectDataAccount = useCallback(
    async (provider: ManagedDataProvider, accountId: string | null) => {
      if (!client) {
        return
      }
      setBusyAccountId(managedDataBusyId(provider, accountId))
      const title = t('accounts.screen.switchFailed', 'Could not switch account')
      try {
        const res = await client.sendRequest('accounts.selectData', { provider, accountId })
        if (!res.ok) {
          setNotice({ title, message: res.error.message })
        } else {
          await refresh()
        }
      } catch (e) {
        setNotice({ title, message: e instanceof Error ? e.message : String(e) })
      } finally {
        setBusyAccountId(null)
      }
    },
    [client, refresh, t]
  )

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
            <ClaudeCodexAccountSections
              snapshot={snapshot}
              now={now}
              busyAccountId={busyAccountId}
              resettingCodex={resettingCodex}
              connected={connState === 'connected'}
              codexResetSupported={codexResetSupported}
              resetScope={resetScope}
              resetScopeLabel={resetScopeLabel}
              onSelect={(provider, accountId) => {
                void selectAccount(provider, accountId)
              }}
              onConfirmReset={confirmCodexReset}
            />
            <ManagedDataAccountSection
              provider="opencode"
              snapshot={snapshot}
              busyAccountId={busyAccountId}
              disabled={busyAccountId !== null || resettingCodex || connState !== 'connected'}
              onSelect={(provider, accountId) => {
                void selectDataAccount(provider, accountId)
              }}
            />
            <ManagedDataAccountSection
              provider="devin"
              snapshot={snapshot}
              busyAccountId={busyAccountId}
              disabled={busyAccountId !== null || resettingCodex || connState !== 'connected'}
              onSelect={(provider, accountId) => {
                void selectDataAccount(provider, accountId)
              }}
            />
            <ProviderUsageSection provider="gemini" snapshot={snapshot} now={now} />
            <AntigravityAccountSection
              snapshot={snapshot}
              now={now}
              client={client}
              connected={connState === 'connected'}
              reloadKey={providerAccountReload}
              busyAccountId={busyAccountId}
              disabled={busyAccountId !== null || resettingCodex || connState !== 'connected'}
              onNotice={setNotice}
              onChanged={refresh}
            />
            <ProviderUsageSection provider="opencodeGo" snapshot={snapshot} now={now} />
            <ProviderUsageSection provider="minimax" snapshot={snapshot} now={now} />
            <ProviderUsageSection provider="grok" snapshot={snapshot} now={now} />
            <ProviderUsageSection provider="cursor" snapshot={snapshot} now={now} />
            <ProviderUsageSection provider="zcode" snapshot={snapshot} now={now} />
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
