import { useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import {
  CalendarClock,
  ChevronLeft,
  List,
  MoreHorizontal,
  PanelLeftClose,
  SquareTerminal,
  UserCircle
} from 'lucide-react-native'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { NavBar, NavBarSubtitleText } from '../components/nav-bar/NavBar'
import type { CollapsingTitle } from '../components/nav-bar/PageTitle'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { PullDownMenu } from '../components/nav-bar/PullDownMenu'
import { StatusDot } from '../components/StatusDot'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useCalmConnectionState } from '../transport/calm-connection-state'
import {
  isConnectionOutage,
  verdictDisplayLabel,
  type ConnectionVerdict
} from '../transport/connection-health'
import type { HostScreenController } from './use-host-screen-controller'

function isErrorVerdict(v: ConnectionVerdict): boolean {
  return isConnectionOutage(v) || v.kind === 'auth-failed'
}

// The host's status line: under the page title at the top, and under the bar title once scrolled.
export function HostConnectionStatus({ controller }: { controller: HostScreenController }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { connectionVerdict, connState, forceReconnectHost, hostId, hostDisplay, lastConnectedAt } =
    controller
  // Why: a drop healed in a few seconds must not flash the host dot amber.
  const presentedConnState = useCalmConnectionState(connState, lastConnectedAt)
  const calmed = presentedConnState !== connState && !isErrorVerdict(connectionVerdict)
  const statusText = isErrorVerdict(connectionVerdict)
    ? verdictDisplayLabel(connectionVerdict)
    : presentedConnState === 'connected'
      ? (hostDisplay.descriptorLine ?? t('connection.connectionHealth.connected', 'Connected'))
      : connectionVerdict.label
  return (
    <>
      {calmed ? (
        <StatusDot state={presentedConnState} />
      ) : (
        <StatusDot state={connState} verdict={connectionVerdict} />
      )}
      <NavBarSubtitleText>{statusText}</NavBarSubtitleText>
      {/* auth-failed has its own banner; the page cannot re-dial the connection the shell owns. */}
      {isConnectionOutage(connectionVerdict) && hostId && forceReconnectHost !== null ? (
        <Pressable
          onPress={() => void forceReconnectHost(hostId)}
          accessibilityRole="button"
          accessibilityLabel={t('hostScreen.hostScreenHeader.reconnect', 'Reconnect')}
          hitSlop={8}
        >
          <Text style={styles.reconnectText}>
            {t('hostScreen.hostScreenHeader.reconnect', 'Reconnect')}
          </Text>
        </Pressable>
      ) : null}
    </>
  )
}

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
    onHideSidebar
  } = controller
  const moreRef = useRef<View>(null)
  const [menuOpen, setMenuOpen] = useState(false)
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
    ...(floatingWorkspaceEnabled
      ? [
          {
            id: 'floating-workspace',
            label: t('hostScreen.hostScreenHeader.floatingWorkspace', 'Floating Workspace'),
            icon: SquareTerminal,
            disabled: disconnected,
            closeBeforePress: true,
            onPress: actions.openFloatingWorkspace
          }
        ]
      : [])
  ]
  return (
    <>
      <NavBar
        leading={
          <>
            <NavBarButton
              icon={ChevronLeft}
              accessibilityLabel={t('hostScreen.hostScreenHeader.backToHosts', 'Back to hosts')}
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
        groups={[navigationGroup]}
        onClose={() => setMenuOpen(false)}
      />
    </>
  )
}

const styles = themedStyleSheet(() => ({
  reconnectText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '600'
  }
}))
