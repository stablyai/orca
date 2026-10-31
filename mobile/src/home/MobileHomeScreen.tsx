import { useCallback, useState } from 'react'
import { Alert, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { getProvenCachedWorktrees } from '../cache/worktree-cache'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { ConfirmModal } from '../components/ConfirmModal'
import { getHostListActionSheetActions } from '../host-list-action-sheet-actions'
import { hostRouteWithNotice } from '../host-route-notice'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { triggerMediumImpact } from '../platform/haptics'
import { useOpenMobileSession } from '../session/use-open-mobile-session'
import { useOpenMobileTasks } from '../tasks/use-open-mobile-tasks'
import { useOpenMobileAutomations } from '../automations/use-open-mobile-automations'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  useDisconnectHostClient,
  useForceReconnect,
  useForgetHostClient
} from '../transport/host-client-hooks'
import { hostEndpointLabel } from '../transport/host-endpoint-label'
import { resolveHomeHostConnectionState } from '../transport/home-host-auto-connect'
import { removeHostAndCloseClient } from '../transport/host-removal-lifecycle'
import { loadHostCatalog } from '../transport/host-store'
import type { HostCatalogEntry, HostProfile } from '../transport/types'
import { useOpenMobileHostEdit } from '../transport/use-open-mobile-host-edit'
import { mobileConnectionPathLabel } from '../transport/mobile-connection-path-label'
import type { HomeJumpBackInRow } from '../worktree/home-jump-back-in'
import { isResumeTargetConfirmedMissing } from '../worktree/home-resume-card'
import { MobileHomeAppUpdateCard } from './MobileHomeAppUpdateCard'
import { MobileHomeBottomBar, MobileHomePairBar } from './MobileHomeBottomBar'
import { MobileHomeEmptyState } from './MobileHomeEmptyState'
import { MobileHomeHostList } from './MobileHomeHostList'
import { MobileHomeJumpBackIn } from './MobileHomeJumpBackIn'
import { MobileHomeTopBar } from './MobileHomeTopBar'
import { useMobileHomeData } from './use-mobile-home-data'
import { newWorkspaceOverlayHref } from '../new-workspace/new-workspace-overlay-route'

export function MobileHomeScreen() {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const data = useMobileHomeData()
  const insets = useSafeAreaInsets()
  const { isWideLayout, contentMaxWidth } = useResponsiveLayout()
  const openMobileHostEdit = useOpenMobileHostEdit()
  const openMobileTasks = useOpenMobileTasks()
  const openMobileAutomations = useOpenMobileAutomations()
  const openMobileSession = useOpenMobileSession()
  const disconnectHostClient = useDisconnectHostClient()
  const forgetHostClient = useForgetHostClient()
  const forceReconnectHost = useForceReconnect()
  const [actionTarget, setActionTarget] = useState<HostProfile | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<{ id: string; name: string } | null>(null)

  const openWorktree = useCallback(
    (row: HomeJumpBackInRow) => {
      if (isResumeTargetConfirmedMissing(row, getProvenCachedWorktrees(row.hostId))) {
        data.router.push(hostRouteWithNotice(row.hostId, 'worktree-missing'))
        return
      }
      openMobileSession({
        hostId: row.hostId,
        worktreeId: row.worktree.worktreeId,
        name: row.worktree.displayName || row.worktree.repo
      })
    },
    [data.router, openMobileSession]
  )

  function openHost(host: HostCatalogEntry): void {
    if (host.credentialStatus === 'missing') {
      data.router.push('/pair-scan')
    } else if (host.credentialStatus === 'temporarily-unavailable') {
      void loadHostCatalog()
        .then(data.setHostCatalog)
        .catch(() =>
          Alert.alert(
            t('home.screen.pairingCheckFailed', 'Could not check pairing'),
            t('home.screen.tryAgain', 'Please try again.')
          )
        )
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
      Alert.alert(
        t('home.screen.removeHostFailed', 'Could not remove host'),
        t('home.screen.tryAgain', 'Please try again.')
      )
    }
  }

  const pairDesktop = () => data.router.push('/pair-scan')
  const actionTargetPath = actionTarget ? data.hostConnections[actionTarget.id]?.path : undefined
  const actionTargetConnected =
    actionTarget != null && data.hostStates[actionTarget.id] === 'connected'

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <MobileHomeTopBar
        showBrand={!data.hostCatalogLoaded || data.hostCatalog.length > 0}
        onOpenSettings={() => data.router.push('/settings')}
      />
      {!data.hostCatalogLoaded ? (
        <View style={styles.fill} />
      ) : data.hostCatalog.length === 0 ? (
        <>
          <MobileHomeEmptyState contentMaxWidth={contentMaxWidth} isWideLayout={isWideLayout} />
          <MobileHomePairBar
            bottomInset={insets.bottom}
            contentMaxWidth={contentMaxWidth}
            isWideLayout={isWideLayout}
            onPairDesktop={pairDesktop}
          />
        </>
      ) : (
        <>
          <MobileHomeHostList
            autoConnectHostIds={data.autoConnectHostIds}
            bottomInset={0}
            contentMaxWidth={contentMaxWidth}
            header={
              data.jumpBackInRows.length > 0 ? (
                <MobileHomeJumpBackIn
                  rows={data.jumpBackInRows}
                  hosts={data.sortedHostCatalog}
                  onOpen={openWorktree}
                />
              ) : null
            }
            footer={<MobileHomeAppUpdateCard />}
            hostAttempts={data.hostAttempts}
            hostLastConnected={data.hostLastConnected}
            hostConnections={data.hostConnections}
            hosts={data.sortedHostCatalog}
            hostStates={data.hostStates}
            isWideLayout={isWideLayout}
            worktreeInfo={data.worktreeInfo}
            onOpen={openHost}
            onOpenActions={(host) => {
              triggerMediumImpact()
              openHostActions(host)
            }}
            onPairDesktop={pairDesktop}
          />
          <MobileHomeBottomBar
            bottomInset={insets.bottom}
            contentMaxWidth={contentMaxWidth}
            isWideLayout={isWideLayout}
            connectedHosts={data.connectedHosts}
            onOpenTasks={(hostId) => openMobileTasks(hostId)}
            onOpenAutomations={openMobileAutomations}
            onCreateWorkspace={() =>
              data.router.push(newWorkspaceOverlayHref(data.connectedHosts.map((host) => host.id)))
            }
          />
        </>
      )}
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
  )
}

const styles = themedStyleSheet(() => ({
  container: { flex: 1, backgroundColor: colors.bgBase },
  fill: { flex: 1 }
}))
