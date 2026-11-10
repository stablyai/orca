import { useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Alert, BackHandler, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useOpenMobileAccounts } from '../accounts/use-open-mobile-accounts'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { ConfirmModal } from '../components/ConfirmModal'
import { getHostListActionSheetActions } from '../host-list-action-sheet-actions'
import { triggerMediumImpact } from '../platform/haptics'
import { useAgentListRowActions } from '../agents/use-agent-list-row-actions'
import { useOpenMobileTasks } from '../tasks/use-open-mobile-tasks'
import { useOpenMobileAutomations } from '../automations/use-open-mobile-automations'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  useDisconnectHostClient,
  useForceReconnect,
  useForgetHostClient
} from '../transport/connection/host-client-hooks'
import { hostEndpointLabel } from '../transport/hosts/host-endpoint-label'
import { resolveHomeHostConnectionState } from '../transport/hosts/home-host-auto-connect'
import { removeHostAndCloseClient } from '../host-catalog/host-removal-lifecycle'
import { loadHostCatalog } from '../host-catalog/host-store'
import type { HostCatalogEntry, HostProfile } from '../host-catalog/host-profile'
import { useOpenMobileHostEdit } from '../host-screen/use-open-mobile-host-edit'
import { mobileConnectionPathLabel } from '../transport/connection/mobile-connection-path-label'
import { newWorkspaceOverlayHref } from '../new-workspace/new-workspace-overlay-route'
import { useMobileHomeData } from './use-mobile-home-data'
import { useHomeSparePage } from './use-home-spare-page'
import { HOME_TABS, type HomeTabId } from './tabs/home-tabs'
import { MobileHomeAgentsTab } from './tabs/MobileHomeAgentsTab'
import { MobileHomeAutomationsTab } from './tabs/MobileHomeAutomationsTab'
import { MobileHomeFab } from './tabs/MobileHomeFab'
import { MobileHomeFeedTab } from './tabs/MobileHomeFeedTab'
import { MobileHomeSettingsTab } from './tabs/MobileHomeSettingsTab'
import { MobileHomeTabBar } from './tabs/MobileHomeTabBar'
import { MobileHomeUsageTab } from './tabs/MobileHomeUsageTab'

// The floating button's height plus its gap above the tab bar.
const FAB_CLEARANCE = 56 + spacing.lg

export function MobileHomeScreen() {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const data = useMobileHomeData()
  useHomeSparePage(data.hostCatalogLoaded ? data.sortedHosts.map((host) => host.id) : [])
  const insets = useSafeAreaInsets()
  const openMobileHostEdit = useOpenMobileHostEdit()
  const openMobileTasks = useOpenMobileTasks()
  const openMobileAutomations = useOpenMobileAutomations()
  const openMobileAccounts = useOpenMobileAccounts()
  const disconnectHostClient = useDisconnectHostClient()
  const forgetHostClient = useForgetHostClient()
  const queryClient = useQueryClient()
  const forceReconnectHost = useForceReconnect()
  const [actionTarget, setActionTarget] = useState<HostProfile | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<{ id: string; name: string } | null>(null)
  const [tab, setTab] = useState<HomeTabId>('feed')
  // A tab mounts on first visit and then stays mounted, keeping its scroll and data.
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<HomeTabId>>(() => new Set(['feed']))
  const [automationsHostId, setAutomationsHostId] = useState<string | null>(null)
  const [tabBarHeight, setTabBarHeight] = useState(0)
  const agentActions = useAgentListRowActions(
    tabBarHeight,
    data.sortedHosts,
    data.applyAgentActivity
  )

  const selectTab = useCallback((next: HomeTabId) => {
    setTab(next)
    setVisitedTabs((visited) => (visited.has(next) ? visited : new Set([...visited, next])))
  }, [])

  // Android Back from another tab returns to Feed before it leaves the app.
  useFocusEffect(
    useCallback(() => {
      if (tab === 'feed') {
        return undefined
      }
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        selectTab('feed')
        return true
      })
      return () => subscription.remove()
    }, [selectTab, tab])
  )

  // Stable handlers keep the memoized Feed sections and desktop rows from redrawing on every Home update.
  const { router, setHostCatalog } = data
  const seeAllAgents = useCallback(() => selectTab('agents'), [selectTab])

  const openHost = useCallback(
    (host: HostCatalogEntry) => {
      if (host.credentialStatus === 'missing') {
        router.push('/pair-scan')
      } else if (host.credentialStatus === 'temporarily-unavailable') {
        void loadHostCatalog()
          .then(setHostCatalog)
          .catch(() =>
            Alert.alert(
              t('home.screen.pairingCheckFailed', 'Could not check pairing'),
              t('home.screen.tryAgain', 'Please try again.')
            )
          )
      } else {
        router.push(`/h/${host.id}`)
      }
    },
    [router, setHostCatalog, t]
  )

  const openHostActions = useCallback((host: HostCatalogEntry) => {
    triggerMediumImpact()
    if (host.profile) {
      setActionTarget(host.profile)
    } else {
      setConfirmRemove(host)
    }
  }, [])

  const openTasks = useCallback((hostId: string) => openMobileTasks(hostId), [openMobileTasks])

  async function handleRemove(): Promise<void> {
    if (!confirmRemove) {
      return
    }
    const host = confirmRemove
    try {
      await removeHostAndCloseClient(host.id, forgetHostClient, queryClient)
      setConfirmRemove(null)
      data.setHostCatalog(await loadHostCatalog())
    } catch {
      setConfirmRemove(host)
      Alert.alert(
        t('home.screen.removeHostFailed', 'Could not remove host'),
        t('home.screen.tryAgain', 'Please try again.')
      )
    }
  }

  const pairDesktop = useCallback(() => router.push('/pair-scan'), [router])
  const actionTargetPath = actionTarget ? data.hostConnections[actionTarget.id]?.path : undefined
  const actionTargetConnected =
    actionTarget != null && data.hostStates[actionTarget.id] === 'connected'

  const paired = data.hostCatalogLoaded && data.hostCatalog.length > 0
  const automationsHostConnected =
    automationsHostId != null && data.hostStates[automationsHostId] === 'connected'
  const fab =
    tab === 'feed' && paired
      ? {
          label: t('home.bottomBar.newWorkspace', 'New workspace'),
          disabled: data.connectedHosts.length === 0,
          // A desktop still on its first connect would make the hint flash at launch.
          hint: data.hostsConnecting
            ? undefined
            : t('home.bottomBar.connectFirst', 'Connect a desktop to start new work.'),
          onPress: () =>
            data.router.push(newWorkspaceOverlayHref(data.connectedHosts.map((host) => host.id)))
        }
      : tab === 'automations' && automationsHostId && automationsHostConnected
        ? {
            label: t('home.automationsTab.newAutomation', 'New automation'),
            disabled: false,
            hint: undefined,
            onPress: () => openMobileAutomations(automationsHostId, { create: true })
          }
        : null
  // The floating button covers the last row unless the list can scroll past it.
  const contentBottom = spacing.xl + (fab ? FAB_CLEARANCE : 0)

  return (
    // Agent rows swipe; no gesture root sits above Home.
    <GestureHandlerRootView style={styles.fill}>
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.fill}>
          {HOME_TABS.map((id) =>
            visitedTabs.has(id) ? (
              <View key={id} style={id === tab ? styles.fill : styles.hidden}>
                {id === 'feed' ? (
                  <MobileHomeFeedTab
                    data={data}
                    bottomInset={contentBottom}
                    agentHandlers={agentActions.handlers}
                    onSeeAllAgents={seeAllAgents}
                    onOpenHost={openHost}
                    onOpenHostActions={openHostActions}
                    onPairDesktop={pairDesktop}
                    onOpenTasks={openTasks}
                  />
                ) : id === 'agents' ? (
                  <MobileHomeAgentsTab
                    data={data}
                    bottomInset={contentBottom}
                    handlers={agentActions.handlers}
                  />
                ) : id === 'usage' ? (
                  <MobileHomeUsageTab
                    hosts={data.sortedHosts}
                    connectedHosts={data.connectedHosts}
                    hostStates={data.hostStates}
                    accountsByHost={data.accountsByHost}
                    stats={data.stats}
                    bottomInset={contentBottom}
                    onOpenAccounts={openMobileAccounts}
                  />
                ) : id === 'automations' ? (
                  <MobileHomeAutomationsTab
                    hosts={data.sortedHosts}
                    connectedHosts={data.connectedHosts}
                    hostStates={data.hostStates}
                    bottomInset={contentBottom}
                    onOpenAutomations={(hostId) => openMobileAutomations(hostId)}
                    onHostChange={setAutomationsHostId}
                  />
                ) : (
                  <MobileHomeSettingsTab bottomInset={contentBottom} />
                )}
              </View>
            ) : null
          )}
        </View>
        <MobileHomeFab
          visible={fab != null}
          disabled={fab?.disabled ?? false}
          accessibilityLabel={fab?.label ?? ''}
          disabledHint={fab?.hint}
          bottom={tabBarHeight + spacing.lg}
          onPress={() => fab?.onPress()}
        />
        <View onLayout={(event) => setTabBarHeight(event.nativeEvent.layout.height)}>
          <MobileHomeTabBar
            tabs={HOME_TABS}
            active={tab}
            bottomInset={insets.bottom}
            agentsBadge={data.agentsNeedingYou.length}
            onSelect={selectTab}
          />
        </View>
        {agentActions.sheet}
        <ActionSheetModal
          visible={actionTarget != null}
          title={actionTarget?.name}
          message={
            actionTarget
              ? [
                  actionTargetConnected && actionTargetPath
                    ? mobileConnectionPathLabel(actionTargetPath)
                    : null,
                  hostEndpointLabel(actionTarget.endpoint)
                ]
                  .filter(Boolean)
                  .join(' · ')
              : undefined
          }
          actions={getHostListActionSheetActions({
            host: actionTarget,
            state: actionTarget
              ? resolveHomeHostConnectionState(
                  actionTarget.id,
                  data.hostStates[actionTarget.id],
                  data.autoConnectHostIds
                )
              : 'disconnected',
            hasEverConnected: actionTarget
              ? (data.hostLastConnected[actionTarget.id] ?? null) != null
              : false,
            onDismiss: () => setActionTarget(null),
            onReconnect: (hostId) => void forceReconnectHost?.(hostId),
            onDisconnect: disconnectHostClient,
            onDiagnostics: (hostId) =>
              data.router.push({ pathname: '/connection-log', params: { hostId } }),
            onEdit: openMobileHostEdit,
            onRemove: (host) => setConfirmRemove(host)
          })}
          onClose={() => setActionTarget(null)}
        />
        <ConfirmModal
          visible={confirmRemove != null}
          title={t('home.screen.removeHostTitle', 'Remove Host')}
          message={t('home.screen.removeHostMessage', 'Remove "{{name}}"? You can re-pair later.', {
            name: confirmRemove?.name
          })}
          confirmLabel={t('common.remove', 'Remove')}
          destructive
          onConfirm={() => void handleRemove()}
          onCancel={() => setConfirmRemove(null)}
        />
      </SafeAreaView>
    </GestureHandlerRootView>
  )
}

const styles = themedStyleSheet(() => ({
  container: { flex: 1, backgroundColor: colors.bgBase },
  fill: { flex: 1 },
  hidden: { display: 'none' }
}))
