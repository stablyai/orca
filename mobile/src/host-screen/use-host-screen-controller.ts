import { useMemo, useReducer, useState } from 'react'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useLocalSearchParams, usePathname } from 'expo-router'
import { useRouteHandoff } from '../navigation/route-handoff'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useHostProtocolGates } from '../components/host-connection/host-protocol-gates-context'
import { visibleHostRouteNotice } from '../host-route-notice'
import { useActiveWorktreeScroll } from '../hooks/use-active-worktree-scroll'
import { useResponsiveLayout } from '../layout/responsive-layout'
import {
  useForgetHostClient,
  useForceReconnect,
  useHostClient
} from '../transport/connection/host-client-hooks'
import {
  useLastConnectedAt,
  useReconnectAttempt,
  useRelayRecoveryStatus
} from '../transport/connection/client-context-connection-metrics'
import {
  useHostDisplayWorktrees,
  useResolvedHostPlatform
} from './workspace-list/use-host-display-worktrees'
import { useHostListSections } from './workspace-list/use-host-list-sections'
import { useSwitchedHostSidebarFeed } from './sidebar-feed/use-host-sidebar-feed'
import { useHostProjectSections } from './catalog/use-host-project-sections'
import { useHostRepoMetadata } from './catalog/use-host-repo-metadata'
import { peekStoredHost, useHostScreenIdentity } from './identity/use-host-screen-identity'
import { useHostScreenState } from './use-host-screen-state'
import { useHostViewSettings } from './view-settings/use-host-view-settings'
import { countActiveWorkspaceFilters } from '../../../src/shared/workspace-view/workspace-row-filters'
import { useHostWorktreeActions } from './workspace-actions/use-host-worktree-actions'
import { useHostListDeleteIntent } from './workspace-actions/use-host-list-delete-intent'
import { useHostWorktreeCatalog } from './catalog/use-host-worktree-catalog'
import { useHostDisplay } from '../host-descriptors/use-host-display'
import { classifyConnection } from '../transport/connection/connection-health'
import { useHostBots } from '../bots/use-host-bots'
import type { BotsChangeScope } from '../worktree/execution-hosts/host-worktree-refresh'
import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import { BOTS_GROUPS_RUNTIME_CAPABILITY } from '../../../src/shared/bot-runtime-capabilities'

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
  useMobileTranslation()
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
  const { hostCapabilities, statusReadable, floatingWorkspaceEnabled, hostInstallationId } =
    useHostProtocolGates()
  const state = useHostScreenState(hostId, peekStoredHost(hostId))
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
  const sidebarFeed = useSwitchedHostSidebarFeed(client, hostId)
  // The host's botsChanged re-reads its own bots; a reconnect or the foreground, every host's.
  const [botsChangeKeys, noteBotsChanged] = useReducer(
    (keys: Record<BotsChangeScope, number>, scope: BotsChangeScope) => ({
      ...keys,
      [scope]: keys[scope] + 1
    }),
    { host: 0, 'host-threads': 0, 'every-host': 0 }
  )
  // The computer New bot starts on, while it is open.
  const [newBotHostId, setNewBotHostId] = useState<ExecutionHostId | null>(null)
  const catalog = useHostWorktreeCatalog({
    client,
    connState,
    embedded,
    hostCapabilities,
    hostStatusReadable: statusReadable,
    hostId,
    sidebarFeed: sidebarFeed?.triggers ?? null,
    state,
    syncViewSettingsFromDesktop: settings.syncViewSettingsFromDesktop,
    onBotsChanged: noteBotsChanged
  })
  useHostRepoMetadata({ client, hostId, state, subscribed: catalog.subscribed })
  const feed = sidebarFeed?.feed ?? null
  useHostProjectSections({
    client,
    hostId,
    state,
    subscribed: catalog.subscribed,
    feedCarriesCatalog: feed?.kind === 'ready' && feed.domains.projectCatalog !== null
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
  const { worktrees: displayWorktrees, hostContextOf } = useHostDisplayWorktrees(
    connState,
    state,
    hostPlatform
  )
  // Row identities, so a workspace swapped for another of the same count still rereads the bots.
  const botRowsKey = useMemo(
    () => displayWorktrees.map((row) => `${row.hostId ?? ''}|${row.worktreeId}`).join('\n'),
    [displayWorktrees]
  )
  const bots = useHostBots({
    client,
    pairedHostId: hostId,
    connState,
    hostCapabilities,
    hostLabel: state.hostName,
    serverHosts: state.serverWorkspaces.hosts,
    rowsKey: botRowsKey,
    changeKey: botsChangeKeys['every-host'],
    pairedChangeKey: botsChangeKeys.host + botsChangeKeys['host-threads'],
    pairedThreadsKey: botsChangeKeys['host-threads']
  })
  const retireDeleteIntent = useHostListDeleteIntent({
    embedded,
    hostId,
    connected: connState === 'connected',
    rows: displayWorktrees,
    bots,
    groupsSupported: hostCapabilities.includes(BOTS_GROUPS_RUNTIME_CAPABILITY),
    newBotOpen: newBotHostId !== null,
    state
  })
  const sectionsResult = useHostListSections({
    client,
    connected: connState === 'connected',
    hostId,
    feed,
    displayWorktrees,
    hostContextOf,
    hostPlatform,
    hostInstallationId,
    hostCapabilities,
    state,
    bots
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
    bots,
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
    onHideSidebar,
    reconnectAttempts,
    relayRecovery,
    retireDeleteIntent,
    routeNotice,
    router,
    sectionsResult,
    setDismissedNotice,
    settings,
    state,
    newBot: {
      hostId: newBotHostId,
      open: setNewBotHostId,
      // Its Home is a new row too; hosts that don't push rows would leave it to the backstop poll.
      created: () => {
        noteBotsChanged('every-host')
        void catalog.fetchWorktrees()
      }
    }
  }
}

export type HostScreenController = ReturnType<typeof useHostScreenController>
