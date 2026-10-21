import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocalSearchParams, usePathname } from 'expo-router'
import { useRouteHandoff } from '../navigation/route-handoff'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'
import { visibleHostRouteNotice } from '../host-route-notice'
import { resolveHostRouteActionState } from '../host-route-action-state'
import { useActiveWorktreeScroll } from '../hooks/use-active-worktree-scroll'
import { useNow } from '../hooks/use-now'
import { useResponsiveLayout } from '../layout/responsive-layout'
import {
  useForgetHostClient,
  useForceReconnect,
  useHostClient
} from '../transport/host-client-hooks'
import {
  useLastConnectedAt,
  useReconnectAttempt,
  useRelayRecoveryStatus
} from '../transport/client-context-connection-metrics'
import { useHostDisplayWorktrees, useResolvedHostPlatform } from './use-host-display-worktrees'
import { useHostListSections } from './use-host-list-sections'
import { useSwitchedHostSidebarFeed } from './use-host-sidebar-feed'
import { useHostProjectSections } from './use-host-project-sections'
import { useHostRepoMetadata, type FetchHostRepoMetadata } from './use-host-repo-metadata'
import { useHostScreenIdentity } from './use-host-screen-identity'
import { useHostScreenState } from './use-host-screen-state'
import { useHostViewSettings } from './use-host-view-settings'
import { countActiveWorkspaceFilters } from '../../../src/shared/workspace-view/workspace-row-filters'
import { useHostWorktreeActions } from './use-host-worktree-actions'
import { useHostWorktreeCatalog } from './use-host-worktree-catalog'
import { useHostDisplay } from '../transport/use-host-display'

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
  // Not `useRouter` directly: the list is the one screen that also runs inside the shell's page,
  // where a route it does not render is handed back to the app rather than pushed into this
  // document. On a phone this is the router and nothing else.
  const router = useRouteHandoff()
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
  const settings = useHostViewSettings({ client, connState, state })
  const hostDisplay = useHostDisplay(
    hostId && state.hostName
      ? { id: hostId, name: state.hostName, ...state.hostStoredDescriptor }
      : null
  )

  useHostScreenIdentity({ client, hostId, state })
  const fetchRepoMetadataOnly = useHostRepoMetadata({ client, connState, hostId, state })
  const sidebarFeed = useSwitchedHostSidebarFeed(client, hostId)
  // Read through a ref so the metadata refresh keeps its identity across installs.
  const feedRef = useRef(sidebarFeed?.feed)
  useEffect(() => {
    feedRef.current = sidebarFeed?.feed
  }, [sidebarFeed?.feed])
  const feedCarriesCatalog = useCallback(
    () => feedRef.current?.kind === 'ready' && feedRef.current.domains.projectCatalog !== null,
    []
  )
  const fetchProjectSections = useHostProjectSections({
    client,
    connState,
    hostId,
    state,
    feedCarriesCatalog
  })
  const fetchRepoMetadata = useCallback<FetchHostRepoMetadata>(
    (options) => {
      void fetchProjectSections(options)
      return fetchRepoMetadataOnly(options)
    },
    [fetchProjectSections, fetchRepoMetadataOnly]
  )
  const catalog = useHostWorktreeCatalog({
    client,
    connState,
    embedded,
    fetchRepoMetadata,
    hostCapabilities,
    hostId,
    sidebarFeed: sidebarFeed?.triggers ?? null,
    state,
    syncViewSettingsFromDesktop: settings.syncViewSettingsFromDesktop
  })
  const actions = useHostWorktreeActions({
    client,
    connState,
    embedded,
    fetchWorktrees: catalog.fetchWorktrees,
    forgetHostClient,
    hostCapabilities,
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

  const hostPlatform = useResolvedHostPlatform(state, hostId)
  const displayWorktrees = useHostDisplayWorktrees(connState, state, hostPlatform)
  const feed = sidebarFeed?.feed ?? null
  const sectionsResult = useHostListSections({
    client,
    hostId,
    feed,
    displayWorktrees,
    hostPlatform,
    state
  })
  const { collapsedGroups, projectOrderBy } = sectionsResult
  const { uniqueRepos } = sectionsResult
  const activeFilterCount = useMemo(
    () =>
      countActiveWorkspaceFilters(
        state.view.filters,
        uniqueRepos.map((repo) => repo.id)
      ),
    [state.view.filters, uniqueRepos]
  )
  const existingWorktreePaths = useMemo(() => state.worktrees.map((w) => w.path), [state.worktrees])
  const activeWorktreeScroll = useActiveWorktreeScroll(sectionsResult.sections, collapsedGroups)

  return {
    actions,
    activeFilterCount,
    activeWorktreeScroll,
    catalog,
    collapsedGroups,
    feed,
    // Resolved: the desktop's value once read; the served catalog's (or the default) before.
    projectOrderBy,
    client,
    connState,
    contentMaxWidth,
    displayWorktrees,
    embedded,
    existingWorktreePaths,
    floatingWorkspaceEnabled,
    forceReconnectHost,
    hostCapabilities,
    hostDisplay,
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
