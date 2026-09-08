import { useEffect, useMemo, useState } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'
import { useHostClient } from '../transport/client-context'
import {
  useLastConnectedAt,
  useReconnectAttempt,
  useRelayRecoveryStatus
} from '../transport/client-context-connection-metrics'
import { useMobileWebRouteParams } from '../mobile-web/use-mobile-web-route-params'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { applyWorktreeRowDisplayState } from '../worktree/worktree-host-row-identity'
import { applyWorktreeHostContextLabels } from '../worktree/worktree-host-context-labels'
import { useWorkspaceSections } from '../worktree/use-workspace-sections'
import { resolveHostRouteActionState } from '../host-route-action-state'
import { visibleHostRouteNotice } from '../host-route-notice'
import { useActiveWorktreeScroll } from '../hooks/use-active-worktree-scroll'
import { useNow } from '../hooks/use-now'
import type { HostWorkspaceOperations } from '../worktree/host-workspace-operations'
import type { HostWorkspaceCreationOperations } from '../worktree/host-workspace-creation-operations'
import type { HostScreenHostState } from '../worktree/host-screen-host-state'
import type { HostScreenShellOperations } from '../worktree/host-screen-shell-operations'
import { defaultHostScreenHostState } from '../worktree/default-host-screen-host-state'
import { defaultHostWorkspaceOperations } from '../worktree/default-host-workspace-operations'
import { defaultHostWorkspaceCreationOperations } from '../worktree/default-host-workspace-creation-operations'
import { useDefaultHostScreenShellOperations } from '../worktree/default-host-screen-shell-operations'
import { useHybridHostScreenState } from './use-hybrid-host-screen-state'
import { useHybridHostScreenSettings } from './use-hybrid-host-screen-settings'
import { useHybridHostRepoMetadata } from './use-hybrid-host-repo-metadata'
import { useHybridHostScreenCatalog } from './use-hybrid-host-screen-catalog'
import { useHybridHostWorktreeActions } from './use-hybrid-host-worktree-actions'

export type HybridHostScreenProps = {
  embedded?: boolean
  hostId?: string
  action?: string
  onHideSidebar?: () => void
  workspaceOperations?: HostWorkspaceOperations
  workspaceCreationOperations?: HostWorkspaceCreationOperations
  connectionState?: ReturnType<typeof useHostClient>['state']
  connectionMetrics?: { reconnectAttempts: number; lastConnectedAt: number | null }
  nativeHostBinding?: boolean
  hostState?: HostScreenHostState
  shellOperations?: HostScreenShellOperations
}

export function useHybridHostScreenController(props: HybridHostScreenProps = {}) {
  const {
    embedded = false,
    hostId: hostIdProp,
    action: actionProp,
    onHideSidebar,
    workspaceOperations: operationsProp,
    workspaceCreationOperations: creationProp,
    connectionState: stateProp,
    connectionMetrics,
    nativeHostBinding = true,
    hostState: hostStateProp,
    shellOperations: shellProp
  } = props
  const params = useMobileWebRouteParams<{ hostId: string; action?: string; notice?: string }>()
  const hostId = hostIdProp ?? params.hostId,
    action = actionProp ?? params.action
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null)
  const noticeParam = params.notice?.trim()
  const hostState = hostStateProp ?? defaultHostScreenHostState
  const { isWideLayout, contentMaxWidth } = useResponsiveLayout(),
    insets = useSafeAreaInsets()
  const nativeHost = useHostClient(nativeHostBinding ? hostId : undefined)
  const connState = stateProp ?? nativeHost.state
  const operations = useMemo(
    () =>
      operationsProp ??
      (nativeHost.client ? defaultHostWorkspaceOperations(nativeHost.client) : null),
    [nativeHost.client, operationsProp]
  )
  const creationOperations = useMemo(
    () =>
      creationProp ??
      (nativeHost.client ? defaultHostWorkspaceCreationOperations(nativeHost.client) : null),
    [nativeHost.client, creationProp]
  )
  const defaultShellOperations = useDefaultHostScreenShellOperations({ hostId, embedded })
  const shellOperations = shellProp ?? defaultShellOperations
  const nativeReconnectAttempts = useReconnectAttempt(hostId)
  const nativeLastConnectedAt = useLastConnectedAt(hostId)
  const reconnectAttempts = connectionMetrics?.reconnectAttempts ?? nativeReconnectAttempts
  const lastConnectedAt = connectionMetrics?.lastConnectedAt ?? nativeLastConnectedAt
  const relayRecovery = useRelayRecoveryStatus(nativeHostBinding ? hostId : undefined)
  const state = useHybridHostScreenState(hostId, action, hostState)
  const settings = useHybridHostScreenSettings({ operations, connState, hostId, state })
  useEffect(() => {
    state.workspaceOperationsRef.current = operations
  }, [operations])
  useEffect(() => {
    state.setHostName('')
    state.setError('')
    state.setCatalogError(null)
    state.setRepoColorsByName(new Map())
    state.setRepoIconsByName(new Map())
    state.setRepoHostIdByRepoId(new Map())
    state.setHostLabelById(new Map())
    state.setHostPlatform(null)
    state.repoMetadataFetchedAtRef.current = 0
    const fresh = hostId ? hostState.cachedWorkspaces(hostId) : null
    if (fresh) {
      state.setWorktrees(fresh)
      state.setLastKnownWorktrees(fresh)
      state.setWorktreesLoaded(true)
    } else {
      state.setWorktrees([])
      state.setLastKnownWorktrees([])
      state.setWorktreesLoaded(false)
    }
    if (!hostId) {
      return
    }
    let stale = false
    void hostState.loadIdentity(hostId).then((host) => {
      if (stale) {
        return
      }
      if (!host) {
        state.setError('Host not found')
        return
      }
      state.setHostName(host.name)
      void hostState.recordConnected(hostId)
    })
    void hostState.loadPinnedWorkspaceIds(hostId).then((pins) => {
      if (!stale) {
        state.setPinnedIds(pins)
      }
    })
    return () => {
      stale = true
    }
  }, [hostId, hostState])
  const fetchRepoMetadata = useHybridHostRepoMetadata({
    operations,
    connState,
    hostId,
    hostState,
    state
  })
  const catalog = useHybridHostScreenCatalog({
    operations,
    connState,
    embedded,
    fetchRepoMetadata,
    hostId,
    hostState,
    state,
    syncViewSettingsFromDesktop: settings.syncViewSettingsFromDesktop
  })
  const actions = useHybridHostWorktreeActions({
    operations,
    connState,
    embedded,
    fetchWorktrees: catalog.fetchWorktrees,
    hostId,
    hostState,
    shellOperations,
    state,
    workspaceCreationOperations: creationOperations
  })
  const resolved = resolveHostRouteActionState(state.routeActionState, action)
  if (resolved !== state.routeActionState) {
    state.setRouteActionState(resolved)
  }
  const displayWorktrees = useMemo(
    () =>
      applyWorktreeHostContextLabels(
        applyWorktreeRowDisplayState(
          connState === 'connected' ? state.worktrees : state.lastKnownWorktrees,
          state.sleptIds,
          state.optimisticActiveWorktreeIdentity
        ),
        {
          repoHostIdByRepoId: state.repoHostIdByRepoId,
          hostLabelById: state.hostLabelById,
          hostPlatform: state.hostPlatform
        }
      ),
    [
      connState,
      state.worktrees,
      state.lastKnownWorktrees,
      state.sleptIds,
      state.optimisticActiveWorktreeIdentity,
      state.repoHostIdByRepoId,
      state.hostLabelById,
      state.hostPlatform
    ]
  )
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
    workspaceStatuses: state.workspaceStatuses,
    worktreesLoaded: state.worktreesLoaded
  })
  const activeWorktreeScroll = useActiveWorktreeScroll(sectionsResult.sections)
  const { hostCapabilities, floatingWorkspaceEnabled } = useHostProtocolGates()
  const routeNotice = visibleHostRouteNotice(embedded, noticeParam, dismissedNotice)
  const router = {
    push: (target: string | { pathname: string; params?: Record<string, string> }) => {
      if (typeof target === 'string') {
        shellOperations.navigateFromHostList(target)
        return
      }
      const query = target.params ? `?${new URLSearchParams(target.params).toString()}` : ''
      shellOperations.navigateFromHostList(`${target.pathname}${query}`)
    }
  }
  const forceReconnectHost = async () => shellOperations.reconnect()
  return {
    actions,
    activeWorktreeScroll,
    catalog,
    client: nativeHost.client,
    connState,
    contentMaxWidth,
    creationOperations,
    displayWorktrees,
    embedded,
    existingWorktreePaths: useMemo(() => state.worktrees.map((w) => w.path), [state.worktrees]),
    floatingWorkspaceEnabled,
    forceReconnectHost,
    hostCapabilities,
    hostId,
    hostState,
    insets,
    isReadOnly: connState === 'auth-failed',
    isWideLayout,
    lastConnectedAt,
    now: useNow(30_000),
    onHideSidebar,
    reconnectAttempts,
    relayRecovery,
    routeNotice,
    noticeParam,
    router,
    sectionsResult,
    setDismissedNotice,
    settings,
    showNewWorktree: resolved.showNewWorktree,
    state,
    shellOperations
  }
}

export type HybridHostScreenController = ReturnType<typeof useHybridHostScreenController>
