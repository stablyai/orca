import { useMemo, useState } from 'react'
import { useLocalSearchParams, usePathname, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useHostProtocolGates } from '../components/HostProtocolGate'
import { visibleHostRouteNotice } from '../host-route-notice'
import { resolveHostRouteActionState } from '../host-route-action-state'
import { useActiveWorktreeScroll } from '../hooks/use-active-worktree-scroll'
import { useNow } from '../hooks/use-now'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { useForgetHostClient, useForceReconnect, useHostClient } from '../transport/client-context'
import {
  useLastConnectedAt,
  useReconnectAttempt,
  useRelayRecoveryStatus
} from '../transport/client-context-connection-metrics'
import { applyWorktreeRowDisplayState } from '../worktree/worktree-host-row-identity'
import { applyWorktreeHostContextLabels } from '../worktree/worktree-host-context-labels'
import { useWorkspaceSections } from '../worktree/use-workspace-sections'
import { useHostRepoMetadata } from './use-host-repo-metadata'
import { useHostScreenIdentity } from './use-host-screen-identity'
import { useHostScreenState } from './use-host-screen-state'
import { useHostViewSettings } from './use-host-view-settings'
import { useHostWorktreeActions } from './use-host-worktree-actions'
import { useHostWorktreeCatalog } from './use-host-worktree-catalog'

export type HostScreenProps = {
  // When true, rendered as the persistent tablet sidebar by the host layout, not as its own routed screen.
  embedded?: boolean
  // Route params aren't in scope when rendered from the layout, so the caller passes these explicitly.
  hostId?: string
  action?: string
  onHideSidebar?: () => void
}

export function useHostScreenController({
  embedded = false,
  hostId: hostIdProp,
  action: actionProp,
  onHideSidebar
}: HostScreenProps = {}) {
  const params = useLocalSearchParams<{ hostId: string; action?: string; notice?: string }>()
  const hostId = hostIdProp ?? params.hostId
  const action = actionProp ?? params.action
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null)
  const noticeParam = params.notice?.trim()
  const routeNotice = visibleHostRouteNotice(embedded, noticeParam, dismissedNotice)
  const router = useRouter()
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  // Why: cap and center the list on wide/tablet canvases; on phones isWideLayout is false so it stays edge-to-edge.
  const { isWideLayout, contentMaxWidth } = useResponsiveLayout()
  // Shared client per host owned by RpcClientProvider. See docs/mobile-shared-client-per-host.md.
  const { client, state: connState } = useHostClient(hostId)
  const reconnectAttempts = useReconnectAttempt(hostId)
  const lastConnectedAt = useLastConnectedAt(hostId)
  const relayRecovery = useRelayRecoveryStatus(hostId)
  const forgetHostClient = useForgetHostClient()
  const forceReconnectHost = useForceReconnect()
  // One tick drives every visible agent row's relative timestamp.
  const now = useNow(30_000)
  const { hostCapabilities, floatingWorkspaceEnabled } = useHostProtocolGates()
  const state = useHostScreenState(hostId, action)
  const settings = useHostViewSettings({ client, connState, hostId, state })

  useHostScreenIdentity({ client, hostId, state })
  const fetchRepoMetadata = useHostRepoMetadata({ client, connState, hostId, state })
  const catalog = useHostWorktreeCatalog({
    client,
    connState,
    embedded,
    fetchRepoMetadata,
    hostId,
    state,
    syncViewSettingsFromDesktop: settings.syncViewSettingsFromDesktop
  })
  const actions = useHostWorktreeActions({
    client,
    connState,
    embedded,
    fetchWorktrees: catalog.fetchWorktrees,
    forgetHostClient,
    hostId,
    pathname,
    router,
    state
  })

  const resolvedRouteActionState = resolveHostRouteActionState(state.routeActionState, action)
  // Why: resolve `action=newWorktree` before commit, but don't reopen after the user closes while the URL persists.
  if (resolvedRouteActionState !== state.routeActionState) {
    state.setRouteActionState(resolvedRouteActionState)
  }
  const showNewWorktree = resolvedRouteActionState.showNewWorktree

  const displayWorktrees = useMemo(() => {
    // Why: live `worktrees` is authoritative only while connected; under the amber
    // mount default, connecting/handshaking must keep the pre-reconnect list too.
    const base = connState === 'connected' ? state.worktrees : state.lastKnownWorktrees
    return applyWorktreeHostContextLabels(
      applyWorktreeRowDisplayState(base, state.sleptIds, state.optimisticActiveWorktreeIdentity),
      {
        repoHostIdByRepoId: state.repoHostIdByRepoId,
        hostLabelById: state.hostLabelById,
        hostPlatform: state.hostPlatform
      }
    )
  }, [
    connState,
    state.worktrees,
    state.lastKnownWorktrees,
    state.sleptIds,
    state.optimisticActiveWorktreeIdentity,
    state.repoHostIdByRepoId,
    state.hostLabelById,
    state.hostPlatform
  ])
  const sectionsResult = useWorkspaceSections({
    displayWorktrees,
    sortMode: state.sortMode,
    filters: state.filters,
    search: state.search,
    groupMode: state.groupMode,
    pinnedIds: state.pinnedIds,
    repoIdsByName: state.repoIdsByName,
    repoColorsByName: state.repoColorsByName,
    collapsedGroups: state.collapsedGroups,
    workspaceStatuses: state.workspaceStatuses
  })
  const existingWorktreePaths = useMemo(() => state.worktrees.map((w) => w.path), [state.worktrees])
  const activeWorktreeScroll = useActiveWorktreeScroll(sectionsResult.sections)

  return {
    actions,
    activeWorktreeScroll,
    catalog,
    client,
    connState,
    contentMaxWidth,
    displayWorktrees,
    embedded,
    existingWorktreePaths,
    floatingWorkspaceEnabled,
    forceReconnectHost,
    hostCapabilities,
    hostId,
    insets,
    isReadOnly: connState === 'auth-failed',
    isWideLayout,
    lastConnectedAt,
    noticeParam,
    now,
    onHideSidebar,
    reconnectAttempts,
    relayRecovery,
    routeNotice,
    router,
    sectionsResult,
    setDismissedNotice,
    settings,
    showNewWorktree,
    state
  }
}

export type HostScreenController = ReturnType<typeof useHostScreenController>
