import { useFocusEffect } from 'expo-router'
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Alert, BackHandler, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useOpenMobileAccounts } from '../accounts/use-open-mobile-accounts'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import { ConfirmModal } from '../components/sheets/ConfirmModal'
import { getHostListActionSheetActions } from '../host-list-action-sheet-actions'
import { triggerMediumImpact } from '../platform/haptics/haptics'
import { useSoftKeyboard } from '../platform/keyboard/keyboard-occlusion'
import { useMobileDictationClearance } from '../dictation/mobile-dictation-host-context'
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
import { useOpenMobileHostEdit } from '../host-screen/identity/use-open-mobile-host-edit'
import { mobileConnectionPathLabel } from '../transport/connection/mobile-connection-path-label'
import { newWorkspaceOverlayHref } from '../new-workspace/new-workspace-overlay-route'
import { useMobileHomeData } from './use-mobile-home-data'
import { useHomeSparePage } from './use-home-spare-page'
import { HOME_TABS, type HomeTabId } from './tabs/home-tabs'
import { MobileHomeAgentsTab } from './tabs/MobileHomeAgentsTab'
import { MobileHomeAutomationsTab } from './tabs/MobileHomeAutomationsTab'
import { MobileHomeBotsTab } from './tabs/MobileHomeBotsTab'
import { HomeNewBotSheet } from './bots/HomeNewBotSheet'
import { homeNewBotComputers, type HomeBotRow } from './bots/home-bot-rows'
import { useOpenBotHome } from '../bots/use-open-bot-home'
import { MobileHomeFab } from './tabs/MobileHomeFab'
import { MobileHomeFeedTab } from './tabs/MobileHomeFeedTab'
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
  const [newBotOpen, setNewBotOpen] = useState(false)
  const openBotHome = useOpenBotHome({ standalone: true })
  const [tabBarHeight, setTabBarHeight] = useState(0)
  const [agentsBarHeight, setAgentsBarHeight] = useState(0)
  const [focused, setFocused] = useState(true)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  // What Home's bottom chrome covers: the tab bar, plus the Agents bar above it.
  const bottomCovered = tabBarHeight + (tab === 'agents' ? agentsBarHeight : 0)
  // The pill floats over whatever screen is on top, so only a focused Home asks it to clear Home's bars.
  useMobileDictationClearance(focused ? bottomCovered : 0)
  const agentActions = useAgentListRowActions(
    bottomCovered,
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
  const seeAllBots = useCallback(() => selectTab('bots'), [selectTab])

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
        t('home.screen.removeComputerFailed', 'Couldn’t remove computer'),
        t('home.screen.tryAgain', 'Please try again.')
      )
    }
  }

  const pairDesktop = useCallback(() => router.push('/pair-scan'), [router])
  const openSettings = useCallback(() => router.push('/settings'), [router])
  const openBot = useCallback(
    (row: HomeBotRow) =>
      row.offline
        ? Alert.alert(
            t('bots.list.cantReach', 'Can’t reach {{host}}. Its bots show when it’s back.', {
              host: row.hostLabel
            })
          )
        : row.kind === 'bot'
          ? openBotHome(row, row.bot)
          : router.push(
              `/h/${encodeURIComponent(row.pairedHostId)}/group/${encodeURIComponent(row.group.id)}`
            ),
    [openBotHome, router, t]
  )
  const { bots, allClients } = data
  // + shows only when a connected computer takes a new bot; the tab's lines say why not.
  const canCreateBot = useMemo(
    () => homeNewBotComputers(bots).some((computer) => computer.refusal === undefined),
    [bots]
  )
  const openNewBot = useCallback(() => setNewBotOpen(true), [])
  const clientOf = useCallback(
    (pairedHostId: string) =>
      allClients.find((entry) => entry.hostId === pairedHostId)?.client ?? null,
    [allClients]
  )
  const actionTargetPath = actionTarget ? data.hostConnections[actionTarget.id]?.path : undefined
  const actionTargetConnected =
    actionTarget != null && data.hostStates[actionTarget.id] === 'connected'

  const automationsHostConnected =
    automationsHostId != null && data.hostStates[automationsHostId] === 'connected'
  const newWorkspace = () =>
    data.router.push(newWorkspaceOverlayHref(data.connectedHosts.map((host) => host.id)))
  // + shows only where it can work: Feed with a computer connected, Automations on a connected one.
  const fab =
    tab === 'feed' && data.connectedHosts.length > 0
      ? { label: t('home.bottomBar.newWorkspace', 'New workspace'), onPress: newWorkspace }
      : tab === 'automations' && automationsHostId && automationsHostConnected
        ? {
            label: t('home.automationsTab.newAutomation', 'New automation'),
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
                    onOpenBot={openBot}
                    onSeeAllBots={seeAllBots}
                    onOpenHost={openHost}
                    onOpenHostActions={openHostActions}
                    onPairDesktop={pairDesktop}
                    onOpenTasks={openTasks}
                    onOpenSettings={openSettings}
                  />
                ) : id === 'bots' ? (
                  <MobileHomeBotsTab
                    data={data}
                    bottomInset={contentBottom}
                    onNewBot={canCreateBot ? openNewBot : undefined}
                    onOpenBot={openBot}
                  />
                ) : id === 'agents' ? (
                  <MobileHomeAgentsTab
                    data={data}
                    handlers={agentActions.handlers}
                    active={id === tab}
                    onBarHeightChange={setAgentsBarHeight}
                    onNewWorkspace={data.connectedHosts.length > 0 ? newWorkspace : undefined}
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
                ) : (
                  <MobileHomeAutomationsTab
                    hosts={data.sortedHosts}
                    connectedHosts={data.connectedHosts}
                    hostStates={data.hostStates}
                    bottomInset={contentBottom}
                    onOpenAutomations={(hostId) => openMobileAutomations(hostId)}
                    onHostChange={setAutomationsHostId}
                  />
                )}
              </View>
            ) : null
          )}
        </View>
        <MobileHomeFab
          visible={fab != null}
          accessibilityLabel={fab?.label ?? ''}
          bottom={tabBarHeight + spacing.lg}
          onPress={() => fab?.onPress()}
        />
        <View onLayout={(event) => setTabBarHeight(event.nativeEvent.layout.height)}>
          <HomeTabBarUnderKeyboard focused={focused}>
            <MobileHomeTabBar
              tabs={HOME_TABS}
              active={tab}
              bottomInset={insets.bottom}
              agentsBadge={data.agentsNeedingYou.length}
              botsBadge={data.bots.needsYou}
              onSelect={selectTab}
            />
          </HomeTabBarUnderKeyboard>
        </View>
        {agentActions.sheet}
        <HomeNewBotSheet
          visible={newBotOpen}
          bots={bots}
          clientOf={clientOf}
          onClose={() => setNewBotOpen(false)}
        />
        <ActionSheetModal
          visible={actionTarget != null}
          title={actionTarget?.name}
          message={
            actionTarget
              ? [
                  [
                    actionTargetConnected && actionTargetPath
                      ? mobileConnectionPathLabel(actionTargetPath)
                      : null,
                    hostEndpointLabel(actionTarget.endpoint)
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  // The why behind a row's "same Wi-Fi only".
                  actionTarget.relay
                    ? null
                    : t(
                        'home.screen.sameNetworkOnly',
                        'Connects on the same Wi-Fi or Tailscale. To connect from anywhere, sign in to Orca on your computer and pair again.'
                      )
                ]
                  .filter(Boolean)
                  .join('\n')
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
          title={t('home.screen.removeComputerTitle', 'Remove computer')}
          message={t(
            'home.screen.removeComputerMessage',
            'Remove “{{name}}”? You can pair it again later.',
            {
              name: confirmRemove?.name
            }
          )}
          confirmLabel={t('common.remove', 'Remove')}
          destructive
          onConfirm={() => void handleRemove()}
          onCancel={() => setConfirmRemove(null)}
        />
      </SafeAreaView>
    </GestureHandlerRootView>
  )
}

// The keyboard covers the tab bar, so it steps out and a tab's bottom search bar sits right on the keyboard.
function HomeTabBarUnderKeyboard(props: { focused: boolean; children: ReactNode }) {
  const keyboardUp = useSoftKeyboard().visible
  // Hidden, not unmounted, so its badges don't replay their entrance; a keyboard above Home leaves it be.
  return <View style={props.focused && keyboardUp && styles.hidden}>{props.children}</View>
}

const styles = themedStyleSheet(() => ({
  container: { flex: 1, backgroundColor: colors.bgBase },
  fill: { flex: 1 },
  hidden: { display: 'none' }
}))
