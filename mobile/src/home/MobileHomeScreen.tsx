import { useCallback, useState } from 'react'
import { Alert, StyleSheet } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useOpenMobileAccounts } from '../accounts/use-open-mobile-accounts'
import { getProvenCachedWorktrees } from '../cache/worktree-cache'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { ConfirmModal } from '../components/ConfirmModal'
import { getHostListActionSheetActions } from '../host-list-action-sheet-actions'
import { hostNewWorktreeRoute } from '../host-route-action-state'
import { hostRouteWithNotice } from '../host-route-notice'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { triggerMediumImpact } from '../platform/haptics'
import { useOpenMobileSession } from '../session/use-open-mobile-session'
import type { TaskProvider } from '../tasks/mobile-task-providers'
import { useOpenMobileTasks } from '../tasks/use-open-mobile-tasks'
import { colors } from '../theme/mobile-theme'
import {
  useDisconnectHostClient,
  useForceReconnect,
  useForgetHostClient
} from '../transport/client-context'
import { hostEndpointLabel } from '../transport/host-endpoint-label'
import { resolveHomeHostConnectionState } from '../transport/home-host-auto-connect'
import { removeHostAndCloseClient } from '../transport/host-removal-lifecycle'
import { loadHostCatalog } from '../transport/host-store'
import type { HostCatalogEntry, HostProfile } from '../transport/types'
import { useOpenMobileHostEdit } from '../transport/use-open-mobile-host-edit'
import type { HomeWorktreeSummary } from '../worktree/home-worktree-info'
import { isResumeTargetConfirmedMissing, type HomeResumeCard } from '../worktree/home-resume-card'
import { MobileHomeEmptyState } from './MobileHomeEmptyState'
import { MobileHomeHostList } from './MobileHomeHostList'
import { MobileHomeListFooter } from './MobileHomeListFooter'
import { MobileHomeTopBar } from './MobileHomeTopBar'
import { useMobileHomeData } from './use-mobile-home-data'

export function MobileHomeScreen() {
  const data = useMobileHomeData()
  const insets = useSafeAreaInsets()
  const { isWideLayout, contentMaxWidth } = useResponsiveLayout()
  const openMobileHostEdit = useOpenMobileHostEdit()
  const openMobileTasks = useOpenMobileTasks()
  const openMobileSession = useOpenMobileSession()
  const openMobileAccounts = useOpenMobileAccounts()
  const disconnectHostClient = useDisconnectHostClient()
  const forgetHostClient = useForgetHostClient()
  const forceReconnectHost = useForceReconnect()
  const [actionTarget, setActionTarget] = useState<HostProfile | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<{ id: string; name: string } | null>(null)

  const openResume = useCallback(
    (card: HomeResumeCard) => {
      if (
        isResumeTargetConfirmedMissing(
          card,
          getProvenCachedWorktrees(card.hostId) as HomeWorktreeSummary[] | null
        )
      ) {
        data.router.push(hostRouteWithNotice(card.hostId, 'worktree-missing'))
        return
      }
      openMobileSession({
        hostId: card.hostId,
        worktreeId: card.worktree.worktreeId,
        name: card.worktree.displayName || card.worktree.repo
      })
    },
    [data.router, openMobileSession]
  )

  const openTasks = useCallback(
    (provider?: TaskProvider) => {
      if (data.primaryHost) {
        openMobileTasks(data.primaryHost.id, provider)
      }
    },
    [data.primaryHost, openMobileTasks]
  )

  function openHost(host: HostCatalogEntry): void {
    if (host.credentialStatus === 'missing') {
      data.router.push('/pair-scan')
    } else if (host.credentialStatus === 'temporarily-unavailable') {
      void loadHostCatalog()
        .then(data.setHostCatalog)
        .catch(() => Alert.alert('Could not check pairing', 'Please try again.'))
    } else {
      data.router.push(`/h/${host.id}`)
    }
  }

  function openHostActions(host: HostCatalogEntry): void {
    if (host.profile) {
      setActionTarget(host.profile)
    } else {
      setConfirmRemove(host)
    }
  }

  async function handleRemove(): Promise<void> {
    if (!confirmRemove) {
      return
    }
    const host = confirmRemove
    try {
      await removeHostAndCloseClient(host.id, forgetHostClient)
      setConfirmRemove(null)
      data.setHostCatalog(await loadHostCatalog())
    } catch {
      setConfirmRemove(host)
      Alert.alert('Could not remove host', 'Please try again.')
    }
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <MobileHomeTopBar onOpenSettings={() => data.router.push('/settings')} />
      {data.hostCatalog.length === 0 ? (
        <MobileHomeEmptyState
          bottomInset={insets.bottom}
          contentMaxWidth={contentMaxWidth}
          isWideLayout={isWideLayout}
          onPairDesktop={() => data.router.push('/pair-scan')}
        />
      ) : (
        <MobileHomeHostList
          autoConnectHostIds={data.autoConnectHostIds}
          bottomInset={insets.bottom}
          contentMaxWidth={contentMaxWidth}
          footer={
            <MobileHomeListFooter
              accountsHosts={data.accountsHosts}
              connectedHosts={data.connectedHosts}
              primaryHost={data.primaryHost}
              primaryTaskProviders={data.primaryTaskProviders}
              resumeCard={data.resumeCard}
              onCreateWorkspace={(hostId) => data.router.push(hostNewWorktreeRoute(hostId))}
              onOpenAccounts={openMobileAccounts}
              onOpenResume={openResume}
              onOpenTasks={openTasks}
              onPairDesktop={() => data.router.push('/pair-scan')}
            />
          }
          hostAttempts={data.hostAttempts}
          hostLastConnected={data.hostLastConnected}
          hostPairingRejected={data.hostPairingRejected}
          hostPaths={data.hostPaths}
          hostPendingPaths={data.hostPendingPaths}
          hosts={data.sortedHostCatalog}
          hostStates={data.hostStates}
          isWideLayout={isWideLayout}
          stats={data.stats}
          worktreeInfo={data.worktreeInfo}
          onOpen={openHost}
          onLongPress={(host) => {
            triggerMediumImpact()
            openHostActions(host)
          }}
          onOpenActions={openHostActions}
        />
      )}
      <ActionSheetModal
        visible={actionTarget != null}
        title={actionTarget?.name}
        message={actionTarget ? hostEndpointLabel(actionTarget.endpoint) : undefined}
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
          onReconnect: (hostId) => void forceReconnectHost(hostId),
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
        title="Remove Host"
        message={`Remove "${confirmRemove?.name}"? You can re-pair later.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => void handleRemove()}
        onCancel={() => setConfirmRemove(null)}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase }
})
