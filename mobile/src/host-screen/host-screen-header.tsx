import { useRef, useState } from 'react'
import { Pressable, Text, type HostInstance } from 'react-native'
import {
  CalendarClock,
  ChevronLeft,
  Link,
  List,
  MoreHorizontal,
  PanelLeftClose,
  Server,
  SquareTerminal,
  UserCircle
} from 'lucide-react-native'
import type { ActionSheetAction } from '../components/sheets/ActionSheetModal'
import { hostDiagnosticsAction, hostEditAction } from '../host-list-action-sheet-actions'
import { NavBar, NavBarSubtitleText } from '../components/nav-bar/NavBar'
import type { CollapsingTitle } from '../components/nav-bar/PageTitle'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { PullDownMenu } from '../components/nav-bar/PullDownMenu'
import { StatusDot } from '../components/feedback/StatusDot'
import { useMobileTranslation, useMobileUiLocale } from '../i18n/use-mobile-translation'
import { useRefreshHint } from '../query/refresh-hint'
import { pressedStyle } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useCalmConnectionState } from '../transport/connection/calm-connection-state'
import {
  isConnectionOutage,
  verdictDisplayLabel,
  type ConnectionVerdict
} from '../transport/connection/connection-health'
import { useHostOfflineBanner } from '../components/host-connection/HostOfflineBanner'
import { formatOfflineAsOfTime } from '../components/host-connection/offline-as-of-time'
import type { HostScreenController } from './use-host-screen-controller'
import { HostSharedLinksSheet } from './host-shared-links-sheet'
import { LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host/execution-host'
import { MCP_SERVERS_RUNTIME_CAPABILITY } from '../../../src/shared/mcp-servers/mcp-servers'
import { useRouteCapability } from '../worktree/execution-hosts/use-route-capability'

function isErrorVerdict(v: ConnectionVerdict): boolean {
  return isConnectionOutage(v) || v.kind === 'auth-failed'
}

/** The computer's one status line: under the page title, and under the bar title once scrolled.
 *  Offline, it says since when, and the page title's copy offers the one Reconnect. */
export function HostConnectionStatus({
  controller,
  withReconnect = false
}: {
  controller: HostScreenController
  /** The page title's line, which has room for Reconnect; the bar's stays one quiet line. */
  withReconnect?: boolean
}) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const uiLocale = useMobileUiLocale()
  const { client, catalog, connectionVerdict, connState, hostDisplay, lastConnectedAt } = controller
  // Why: a drop healed in a few seconds must not flash the host dot amber.
  const presentedConnState = useCalmConnectionState(connState, lastConnectedAt)
  const calmed = presentedConnState !== connState && !isErrorVerdict(connectionVerdict)
  const outage = isConnectionOutage(connectionVerdict)
  // When the shown rows were last live: the drop this document saw, else when they were read.
  const offlineAsOf =
    useHostOfflineBanner({
      client,
      connState,
      lastConnectedAt,
      outage,
      forceReconnect: null,
      hasData: true,
      asOf: catalog.readAt
    })?.asOf ?? null
  // A relay's own reason (sign in, computer off) says more than a time.
  const offlineSince =
    outage && !connectionVerdict.detail && offlineAsOf !== null
      ? t('hostScreen.hostScreenHeader.offlineSince', 'Offline since {{time}}', {
          time: formatOfflineAsOfTime(offlineAsOf, t, uiLocale)
        })
      : null
  const statusText =
    offlineSince !== null
      ? outage && connectionVerdict.hint
        ? verdictDisplayLabel({ ...connectionVerdict, label: offlineSince }, t)
        : offlineSince
      : connectionVerdict.kind === 'auth-failed'
        ? t('hostScreen.hostScreenHeader.notConnected', 'Not connected')
        : isErrorVerdict(connectionVerdict)
          ? verdictDisplayLabel(connectionVerdict, t)
          : presentedConnState === 'connected'
            ? (hostDisplay.machineLine ??
              hostDisplay.descriptorLine ??
              t('connection.connectionHealth.connected', 'Connected'))
            : connectionVerdict.label
  // A list with nothing to show offers Reconnect in its own body instead.
  const shownRows = controller.feed
    ? controller.sectionsResult.sections.length
    : controller.displayWorktrees.length
  const reconnect = withReconnect && outage && shownRows > 0 ? controller.reconnect : null
  return (
    <>
      {calmed ? (
        <StatusDot state={presentedConnState} />
      ) : (
        <StatusDot state={connState} verdict={connectionVerdict} />
      )}
      <NavBarSubtitleText>{statusText}</NavBarSubtitleText>
      {reconnect ? (
        <Pressable
          style={({ pressed }) => [styles.reconnect, pressed && pressedStyle]}
          onPress={reconnect}
          accessibilityRole="button"
          hitSlop={RECONNECT_HIT_SLOP}
        >
          <Text style={styles.reconnectText}>
            {t('hostScreen.hostScreenHeader.reconnect', 'Reconnect')}
          </Text>
        </Pressable>
      ) : null}
    </>
  )
}

// Grows Reconnect's 14 pt line to a 44 pt target without moving the title.
const RECONNECT_HIT_SLOP = { top: 15, bottom: 15, left: 12, right: 12 } as const

export function HostScreenHeader({
  controller,
  collapsingTitle
}: {
  controller: HostScreenController
  /** Set when the list shows the host name as its PageTitle; the bar then shows it only once scrolled. */
  collapsingTitle?: CollapsingTitle
}) {
  const t = useMobileTranslation()
  const {
    actions,
    connState,
    embedded,
    floatingWorkspaceEnabled,
    hostId,
    hostDisplay,
    onHideSidebar,
    router
  } = controller
  const moreRef = useRef<HostInstance>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [sharedLinksOpen, setSharedLinksOpen] = useState(false)
  // The computer's own bot links, once it lists bots; a server's live under that server's account.
  const listsBots = controller.bots.some(
    (entry) => entry.kind === 'listed' && entry.hostId === LOCAL_EXECUTION_HOST_ID
  )
  const showRefreshLine = useRefreshHint(controller.catalog.revalidating)
  const disconnected = connState !== 'connected'
  // Only while the host's MCP servers switch is on; a host that hasn't answered yet lists nothing.
  const mcpServers = useRouteCapability(MCP_SERVERS_RUNTIME_CAPABILITY)
  const hostPath = `/h/${encodeURIComponent(hostId)}`

  const navigationGroup: ActionSheetAction[] = [
    {
      id: 'tasks',
      label: t('hostScreen.hostScreenHeader.tasks', 'Tasks'),
      icon: List,
      disabled: disconnected,
      closeBeforePress: true,
      onPress: () => actions.navigateFromHostList(`${hostPath}/tasks`)
    },
    {
      id: 'automations',
      label: t('hostScreen.hostScreenHeader.automations', 'Automations'),
      icon: CalendarClock,
      disabled: disconnected,
      closeBeforePress: true,
      onPress: () => actions.navigateFromHostList(`${hostPath}/automations`)
    },
    {
      id: 'accounts',
      label: t('hostScreen.hostScreenHeader.accounts', 'Accounts'),
      icon: UserCircle,
      disabled: disconnected,
      closeBeforePress: true,
      onPress: () => actions.navigateFromHostList(`${hostPath}/accounts`)
    },
    ...(mcpServers
      ? [
          {
            id: 'mcp-servers',
            label: t('hostScreen.hostScreenHeader.mcpServers', 'MCP servers'),
            icon: Server,
            disabled: disconnected,
            closeBeforePress: true,
            onPress: () => actions.navigateFromHostList(`${hostPath}/mcp`)
          }
        ]
      : []),
    ...(listsBots
      ? [
          {
            id: 'shared-links',
            label: t('hostScreen.hostScreenHeader.sharedLinks', 'Shared links'),
            icon: Link,
            disabled: disconnected,
            closeBeforePress: true,
            onPress: () => setSharedLinksOpen(true)
          }
        ]
      : []),
    ...(floatingWorkspaceEnabled
      ? [
          {
            id: 'floating-workspace',
            label: t('hostScreen.hostScreenHeader.floatingWorkspace', 'Floating workspace'),
            icon: SquareTerminal,
            disabled: disconnected,
            closeBeforePress: true,
            onPress: actions.openFloatingWorkspace
          }
        ]
      : [])
  ]
  // Unlike the screens above, these work on the saved host, so they stay offered while disconnected.
  const hostGroup: ActionSheetAction[] = [
    hostEditAction(() => actions.navigateFromHostList(`${hostPath}/edit`), t),
    hostDiagnosticsAction(() => router.push({ pathname: '/connection-log', params: { hostId } }), t)
  ]
  return (
    <>
      <NavBar
        leading={
          <>
            <NavBarButton
              icon={ChevronLeft}
              accessibilityLabel={t('common.back', 'Back')}
              onPress={actions.leaveHost}
            />
            {embedded && onHideSidebar ? (
              <NavBarButton
                icon={PanelLeftClose}
                accessibilityLabel={t('hostScreen.hostScreenHeader.hideSidebar', 'Hide sidebar')}
                onPress={onHideSidebar}
              />
            ) : null}
          </>
        }
        title={hostDisplay.title}
        subtitle={<HostConnectionStatus controller={controller} />}
        refreshing={showRefreshLine}
        titleOpacity={collapsingTitle?.barTitleOpacity}
        dividerOpacity={collapsingTitle?.barDividerOpacity}
        trailing={
          <NavBarButton
            ref={moreRef}
            icon={MoreHorizontal}
            accessibilityLabel={t('hostScreen.hostScreenHeader.moreActions', 'More actions')}
            onPress={() => setMenuOpen(true)}
            active={menuOpen}
          />
        }
      />
      <PullDownMenu
        visible={menuOpen}
        anchorRef={moreRef}
        groups={[navigationGroup, hostGroup]}
        onClose={() => setMenuOpen(false)}
      />
      {listsBots ? (
        <HostSharedLinksSheet
          controller={controller}
          visible={sharedLinksOpen}
          onClose={() => setSharedLinksOpen(false)}
        />
      ) : null}
    </>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  // Right-aligned on the subtitle line, like a section's link.
  reconnect: {
    marginLeft: 'auto'
  },
  // Held to the subtitle's line so the title block keeps its height when Reconnect appears.
  reconnectText: {
    color: colors.accentBlue,
    fontSize: 13,
    lineHeight: 14,
    fontWeight: '600'
  }
}))
