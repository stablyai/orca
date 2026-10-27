import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocalSearchParams, usePathname } from 'expo-router'
import { useRouteHandoff } from '../navigation/route-handoff'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'
import { visibleHostRouteNotice } from '../host-route-notice'
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
import { classifyConnection } from '../transport/connection-health'

export type HostScreenProps = {
  embedded?: boolean
  // Layout-mounted sidebars lack route params; receive them explicitly.
  hostId?: string
  onHideSidebar?: () => void
}

export function useHostScreenController({
  embedded = false,
  hostId: hostIdProp,
  onHideSidebar
}: HostScreenProps = {}) {
  const params = useLocalSearchParams<{ hostId: string; notice?: string }>()
  const hostId = hostIdProp ?? params.hostId
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null)
  const noticeParam = params.notice?.trim()
  const routeNotice = visibleHostRouteNotice(embedded, noticeParam, dismissedNotice)
  // Use route handoff so the shell opens routes absent from the page instead of pushing them into this document.
  const router = useRouteHandoff()
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  const { isWideLayout, contentMaxWidth } = useResponsiveLayout()
  const { client, state: connState } = useHostClient(hostId)
  const reconnectAttempts = useReconnectAttempt(hostId)
  const lastConnectedAt = useLastConnectedAt(hostId)
  const relayRecovery = useRelayRecoveryStatus(hostId)
  const forgetHostClient = useForgetHostClient()
  const forceReconnectHost = useForceReconnect()
  const now = useNow(30_000)
  const { hostCapabilities, floatingWorkspaceEnabled } = useHostProtocolGates()
  const state = useHostScreenState(hostId)
  const settings = useHostViewSettings({ client, connState, state })
  const connectionVerdict = classifyConnection({
    state: connState,
    reconnectAttempts,
    lastConnectedAt,
    hostName: state.hostName,
    ...relayRecovery
  })
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
    projectOrderBy,
    client,
    connectionVerdict,
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
    state
  }
}

export type HostScreenController = ReturnType<typeof useHostScreenController>
