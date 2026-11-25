import { useCallback, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Alert } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useOpenMobileAccounts } from '../accounts/use-open-mobile-accounts'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import { ConfirmModal } from '../components/sheets/ConfirmModal'
import { getHostListActionSheetActions } from '../host-list-action-sheet-actions'
import { triggerMediumImpact } from '../platform/haptics/haptics'
import { useAgentListRowActions } from '../agents/use-agent-list-row-actions'
import { useOpenMobileTasks } from '../tasks/use-open-mobile-tasks'
import { useOpenMobileAutomations } from '../automations/use-open-mobile-automations'
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
import type { HomeTabId } from './tabs/home-tabs'
import { HomeNewBotSheet } from './bots/HomeNewBotSheet'
import { homeNewBotComputers, type HomeBotRow } from './bots/home-bot-rows'
import { useOpenBotHome } from '../bots/use-open-bot-home'

/** A tab's one creating action: the floating button on the drawn bar, a header button natively. */
export type HomeCreateAction = {
  label: string
  disabled: boolean
  /** Says why it is disabled. */
  hint: string | undefined
  onPress: () => void
}

/** Home's data, handlers and sheets, shared by every tab whichever bar draws them. */
export function useMobileHomeController(options: {
  toastBottomInset: number
  onSeeAllAgents: () => void
  onSeeAllBots: () => void
}) {
  const t = useMobileTranslation()
  const data = useMobileHomeData()
  useHomeSparePage(data.hostCatalogLoaded ? data.sortedHosts.map((host) => host.id) : [])
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
  const [newBotOpen, setNewBotOpen] = useState(false)
  const openBotHome = useOpenBotHome()
  const agentActions = useAgentListRowActions(
    options.toastBottomInset,
    data.sortedHosts,
    data.applyAgentActivity
  )

  // Stable handlers keep the memoized Feed sections and desktop rows from redrawing on every Home update.
  const { router, setHostCatalog } = data

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

  const paired = data.hostCatalogLoaded && data.hostCatalog.length > 0
  const createAction = (
    tab: HomeTabId,
    automationsHostId: string | null
  ): HomeCreateAction | null =>
    tab === 'feed' && paired
      ? {
          label: t('home.bottomBar.newWorkspace', 'New workspace'),
          disabled: data.connectedHosts.length === 0,
          // A desktop still on its first connect would make the hint flash at launch.
          hint: data.hostsConnecting
            ? undefined
            : t('home.bottomBar.connectFirst', 'Connect a desktop to start new work.'),
          onPress: () =>
            router.push(newWorkspaceOverlayHref(data.connectedHosts.map((host) => host.id)))
        }
      : tab === 'automations' &&
          automationsHostId &&
          data.hostStates[automationsHostId] === 'connected'
        ? {
            label: t('home.automationsTab.newAutomation', 'New automation'),
            disabled: false,
            hint: undefined,
            onPress: () => openMobileAutomations(automationsHostId, { create: true })
          }
        : null

  const overlays = (
    <>
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
            router.push({ pathname: '/connection-log', params: { hostId } }),
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
    </>
  )

  return {
    data,
    agentHandlers: agentActions.handlers,
    onSeeAllAgents: options.onSeeAllAgents,
    onSeeAllBots: options.onSeeAllBots,
    openHost,
    openHostActions,
    openTasks,
    pairDesktop,
    openSettings,
    openBot,
    onNewBot: canCreateBot ? openNewBot : undefined,
    openMobileAccounts,
    openMobileAutomations,
    createAction,
    overlays
  }
}

export type MobileHomeController = ReturnType<typeof useMobileHomeController>
