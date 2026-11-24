import { useRef, useState } from 'react'
import { Pressable, Text, type HostInstance } from 'react-native'
import {
  CalendarClock,
  ChevronLeft,
  Link,
  List,
  MoreHorizontal,
  PanelLeftClose,
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
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useRefreshHint } from '../query/refresh-hint'
import { colors, pressedStyle } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useCalmConnectionState } from '../transport/connection/calm-connection-state'
import {
  isConnectionOutage,
  type ConnectionVerdict
} from '../transport/connection/connection-health'
import { formatOfflineAsOfTime } from '../components/host-connection/offline-as-of-time'
import type { HostScreenController } from './use-host-screen-controller'
import { HostSharedLinksSheet } from './host-shared-links-sheet'
import { LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host/execution-host'

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
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { connectionVerdict, connState, hostDisplay, lastConnectedAt } = controller
  // Why: a drop healed in a few seconds must not flash the host dot amber.
  const presentedConnState = useCalmConnectionState(connState, lastConnectedAt)
  const calmed = presentedConnState !== connState && !isErrorVerdict(connectionVerdict)
  const outage = isConnectionOutage(connectionVerdict)
  const statusText =
    outage && lastConnectedAt !== null
      ? t('hostScreen.hostScreenHeader.offlineSince', 'Offline since {{time}}', {
          time: formatOfflineAsOfTime(lastConnectedAt)
        })
      : connectionVerdict.kind === 'auth-failed'
        ? t('hostScreen.hostScreenHeader.notConnected', 'Not connected')
        : isErrorVerdict(connectionVerdict)
          ? connectionVerdict.label
          : presentedConnState === 'connected'
            ? (hostDisplay.machineLine ??
              hostDisplay.descriptorLine ??
              t('connection.connectionHealth.connected', 'Connected'))
            : connectionVerdict.label
  // An empty list offers Reconnect in its own body instead.
  const reconnect =
    withReconnect && outage && controller.sectionsResult.sections.length > 0
      ? controller.reconnect
      : null
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
  useMobileColorScheme()
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
    hostEditAction(() => actions.navigateFromHostList(`${hostPath}/edit`)),
    hostDiagnosticsAction(() => router.push({ pathname: '/connection-log', params: { hostId } }))
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

const styles = themedStyleSheet(() => ({
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
