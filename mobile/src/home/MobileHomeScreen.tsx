import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Activity, QrCode, RefreshCw } from 'lucide-react-native'
import { useOpenMobileAccounts } from '../accounts/use-open-mobile-accounts'
import { getProvenCachedWorktrees } from '../cache/worktree-cache'
import { ActionSheetModal, type ActionSheetAction } from '../components/ActionSheetModal'
import { ConfirmModal } from '../components/ConfirmModal'
import { LARGE_TITLE_COLLAPSE_OFFSET } from '../components/ui/NavBar'
import { StateView } from '../components/ui/StateView'
import { getHostListActionSheetActions } from '../host-list-action-sheet-actions'
import { hostRouteWithNotice } from '../host-route-notice'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { triggerError, triggerMediumImpact } from '../platform/haptics'
import { useOpenMobileSession } from '../session/use-open-mobile-session'
import { useOpenMobileTasks } from '../tasks/use-open-mobile-tasks'
import { colors, spacing } from '../theme/mobile-theme'
import {
  useDisconnectHostClient,
  useForceReconnect,
  useForgetHostClient
} from '../transport/host-client-hooks'
import { hostEndpointLabel } from '../transport/host-endpoint-label'
import { resolveHomeHostConnectionState } from '../transport/home-host-auto-connect'
import { removeHostAndCloseClient } from '../transport/host-removal-lifecycle'
import { loadHostCatalog } from '../transport/host-store'
import type { RpcClient } from '../transport/rpc-client'
import type { HostCatalogEntry } from '../transport/types'
import { useOpenMobileHostEdit } from '../transport/use-open-mobile-host-edit'
import type { HomeWorktreeSummary } from '../worktree/home-worktree-info'
import { isResumeTargetConfirmedMissing, type HomeResumeCard } from '../worktree/home-resume-card'
import { MobileHomeAccountUsageCards } from './MobileHomeAccountUsageCards'
import { MobileHomeBottomBar } from './MobileHomeBottomBar'
import { MobileHomeEmptyState } from './MobileHomeEmptyState'
import { MobileHomeHostList } from './MobileHomeHostList'
import { MobileHomeListHeader } from './MobileHomeListHeader'
import { MobileHomeTopBar } from './MobileHomeTopBar'
import { MobileHomeWorkspaceSection } from './MobileHomeWorkspaceSection'
import { useMobileHomeData } from './use-mobile-home-data'
import { newWorkspaceOverlayHref } from '../new-workspace/new-workspace-overlay-route'

// A secure-store read usually lands well inside this, so most launches never see the spinner.
const LOADING_REVEAL_DELAY_MS = 400
// The bottom bar's height before its first layout: padding plus one large button.
const BOTTOM_BAR_ESTIMATE = spacing.md + 50

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
  const [actionTarget, setActionTarget] = useState<HostCatalogEntry | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<{ id: string; name: string } | null>(null)
  // The large title scrolls with the list; the bar shows "Orca" once it has gone under.
  const [titleCollapsed, setTitleCollapsed] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [bottomBarHeight, setBottomBarHeight] = useState<number | null>(null)
  const onBottomBarLayout = useCallback((event: LayoutChangeEvent) => {
    setBottomBarHeight(event.nativeEvent.layout.height)
  }, [])
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = event.nativeEvent.contentOffset.y
    setTitleCollapsed(y > LARGE_TITLE_COLLAPSE_OFFSET)
    setScrolled(y > 0)
  }, [])
  const hostClients = useMemo(() => {
    const byHostId: Record<string, RpcClient> = {}
    for (const entry of data.allClients) {
      byHostId[entry.hostId] = entry.client
    }
    return byHostId
  }, [data.allClients])

  const openWorkspace = useCallback(
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

  function retryCredential(): void {
    void loadHostCatalog()
      .then(data.setHostCatalog)
      .catch(() => {
        triggerError()
        Alert.alert('Could not check pairing', 'Please try again.')
      })
  }

  function openHost(host: HostCatalogEntry): void {
    if (host.credentialStatus === 'missing') {
      data.router.push('/pair-scan')
    } else if (host.credentialStatus === 'temporarily-unavailable') {
      retryCredential()
    } else {
      data.router.push(`/h/${host.id}`)
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
      triggerError()
      Alert.alert('Could not remove desktop', 'Please try again.')
    }
  }

  const actionProfile = actionTarget?.profile ?? null
  const actions: ActionSheetAction[] = actionProfile
    ? getHostListActionSheetActions({
        host: actionProfile,
        state: resolveHomeHostConnectionState(
          actionProfile.id,
          data.hostStates[actionProfile.id],
          data.autoConnectHostIds
        ),
        hasEverConnected: (data.hostLastConnected[actionProfile.id] ?? null) != null,
        onDismiss: () => setActionTarget(null),
        onReconnect: (hostId) => void forceReconnectHost?.(hostId),
        onDisconnect: disconnectHostClient,
        onDiagnostics: (hostId) =>
          data.router.push({ pathname: '/connection-log', params: { hostId } }),
        onEdit: openMobileHostEdit,
        onRemove: (host) => setConfirmRemove(host)
      })
    : actionTarget
      ? brokenPairingActions(actionTarget, {
          onRetry: retryCredential,
          onRepair: () => data.router.push('/pair-scan'),
          onDiagnostics: (hostId) =>
            data.router.push({ pathname: '/connection-log', params: { hostId } }),
          onRemove: (host) => setConfirmRemove(host)
        })
      : []

  const empty = data.hostCatalogLoaded && data.hostCatalog.length === 0
  const showList = data.hostCatalogLoaded && !empty
  const bottomPadding =
    (bottomBarHeight ?? BOTTOM_BAR_ESTIMATE + Math.max(insets.bottom, spacing.lg)) + spacing.xl

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <MobileHomeTopBar
        onOpenSettings={() => data.router.push('/settings')}
        titleVisible={data.hostCatalogLoaded ? showList && titleCollapsed : true}
        scrolled={showList && scrolled}
      />
      {!data.hostCatalogLoaded ? (
        <MobileHomeLoadingState />
      ) : empty ? (
        <MobileHomeEmptyState
          bottomInset={insets.bottom}
          contentMaxWidth={contentMaxWidth}
          isWideLayout={isWideLayout}
          onPairDesktop={() => data.router.push('/pair-scan')}
        />
      ) : (
        <View style={styles.body}>
          <MobileHomeHostList
            autoConnectHostIds={data.autoConnectHostIds}
            bottomPadding={bottomPadding}
            contentMaxWidth={contentMaxWidth}
            header={
              <MobileHomeListHeader
                workingAgents={data.workingAgentCount}
                needsYou={data.needsYou.length}
              />
            }
            workspaces={
              <>
                <MobileHomeWorkspaceSection
                  waiting
                  cards={data.needsYou}
                  hosts={data.sortedHostCatalog}
                  onOpen={openWorkspace}
                />
                <MobileHomeWorkspaceSection
                  waiting={false}
                  cards={data.jumpBackIn}
                  hosts={data.sortedHostCatalog}
                  onOpen={openWorkspace}
                />
              </>
            }
            footer={
              <MobileHomeAccountUsageCards items={data.accountsHosts} onOpen={openMobileAccounts} />
            }
            hostAttempts={data.hostAttempts}
            hostClients={hostClients}
            hostLastConnected={data.hostLastConnected}
            hostConnections={data.hostConnections}
            hosts={data.sortedHostCatalog}
            hostStates={data.hostStates}
            isWideLayout={isWideLayout}
            worktreeInfo={data.worktreeInfo}
            onScroll={onScroll}
            onOpen={openHost}
            onLongPress={(host) => {
              triggerMediumImpact()
              setActionTarget(host)
            }}
            onOpenActions={setActionTarget}
            onPairDesktop={() => data.router.push('/pair-scan')}
          />
          <MobileHomeBottomBar
            connectedHosts={data.connectedHosts}
            bottomInset={insets.bottom}
            contentMaxWidth={contentMaxWidth}
            isWideLayout={isWideLayout}
            onOpenTasks={(hostId) => openMobileTasks(hostId)}
            onCreateWorkspace={() =>
              data.router.push(newWorkspaceOverlayHref(data.connectedHosts.map((host) => host.id)))
            }
            onLayout={onBottomBarLayout}
          />
        </View>
      )}
      <ActionSheetModal
        visible={actionTarget != null}
        title={actionTarget?.name}
        message={actionTarget ? hostEndpointLabel(actionTarget.endpoint) : undefined}
        actions={actions}
        onClose={() => setActionTarget(null)}
      />
      <ConfirmModal
        visible={confirmRemove != null}
        title="Remove desktop"
        message={`Remove "${confirmRemove?.name}"? You can pair it again later.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => void handleRemove()}
        onCancel={() => setConfirmRemove(null)}
      />
    </SafeAreaView>
  )
}

/** The menu for a desktop whose pairing this phone cannot read: fix it first, remove it last. */
function brokenPairingActions(
  host: HostCatalogEntry,
  handlers: {
    onRetry: () => void
    onRepair: () => void
    onDiagnostics: (hostId: string) => void
    onRemove: (host: { id: string; name: string }) => void
  }
): ActionSheetAction[] {
  const fix: ActionSheetAction =
    host.credentialStatus === 'temporarily-unavailable'
      ? { label: 'Try again', icon: RefreshCw, onPress: handlers.onRetry }
      : { label: 'Pair again', icon: QrCode, closeBeforePress: true, onPress: handlers.onRepair }
  return [
    fix,
    {
      label: 'Network diagnostics',
      icon: Activity,
      closeBeforePress: true,
      onPress: () => handlers.onDiagnostics(host.id)
    },
    {
      label: 'Remove',
      destructive: true,
      closeBeforePress: true,
      onPress: () => handlers.onRemove(host)
    }
  ]
}

/** Shown only if the paired-desktop read is slow, so a paired user never sees the first-run screen. */
function MobileHomeLoadingState() {
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setRevealed(true), LOADING_REVEAL_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])
  return revealed ? <StateView loading title="Loading desktops…" /> : null
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  body: { flex: 1 }
})
