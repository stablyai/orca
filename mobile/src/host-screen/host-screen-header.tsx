import { Pressable, Text, View } from 'react-native'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { WorkspaceOptionsCountBadge } from './workspace-options-count-badge'
import {
  ChevronLeft,
  List,
  PanelLeftClose,
  Search,
  SquareTerminal,
  UserCircle,
  X
} from 'lucide-react-native'
import { StatusDot } from '../components/StatusDot'
import { isConnectionOutage, type ConnectionVerdict } from '../transport/connection-health'
import { useCalmConnectionState } from '../transport/calm-connection-state'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { hostScreenStyles as styles } from './host-screen-styles'
import { HostRailActions, hostListActions } from './host-rail-actions'
import { useSideRailClaim, useSideRailEdge } from '../layout/side-rail'
import type { HostScreenController } from './use-host-screen-controller'

function isErrorVerdict(v: ConnectionVerdict): boolean {
  return isConnectionOutage(v) || v.kind === 'auth-failed'
}

function workspaceOptionsAccessibilityLabel(t: Translate, count: number): string {
  if (count <= 0) {
    return t('hostScreen.hostScreenHeader.workspaceOptions', 'Workspace options')
  }
  return count === 1
    ? t(
        'hostScreen.hostScreenHeader.activeFilters_one',
        'Workspace options ({{count}} filter active)',
        { count }
      )
    : t(
        'hostScreen.hostScreenHeader.activeFilters_other',
        'Workspace options ({{count}} filters active)',
        { count }
      )
}

export function HostScreenHeader({ controller }: { controller: HostScreenController }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const {
    actions,
    connectionVerdict,
    connState,
    embedded,
    floatingWorkspaceEnabled,
    forceReconnectHost,
    hostId,
    hostDisplay,
    lastConnectedAt,
    onHideSidebar,
    state
  } = controller
  // Why: a drop healed in a few seconds must not flash the host dot amber.
  const presentedConnState = useCalmConnectionState(connState, lastConnectedAt)
  // The Duo's side rail takes the list's icons: on the cover always, beside the sidebar only while the detail pane is empty.
  const railEdge = useSideRailEdge()
  const railPlacement =
    railEdge === null ? null : !embedded ? 'cover' : controller.actionsInRail ? 'split' : null
  const railActions = railPlacement !== null
  useSideRailClaim(
    railPlacement ? <HostRailActions controller={controller} placement={railPlacement} /> : null
  )

  return (
    <View style={styles.topChrome}>
      <View style={styles.statusBar}>
        <Pressable
          style={styles.backButton}
          onPress={actions.leaveHost}
          accessibilityRole="button"
          accessibilityLabel={t('hostScreen.hostScreenHeader.backToHosts', 'Back to hosts')}
          hitSlop={8}
        >
          <ChevronLeft size={22} color={colors.textPrimary} />
        </Pressable>
        <View style={styles.hostIdentity}>
          <View style={styles.hostIdentityLine}>
            {presentedConnState !== connState && !isErrorVerdict(connectionVerdict) ? (
              <StatusDot state={presentedConnState} />
            ) : (
              <StatusDot state={connState} verdict={connectionVerdict} />
            )}
            <Text style={styles.hostNameText} numberOfLines={1}>
              {hostDisplay.title}
            </Text>
          </View>
          {hostDisplay.descriptorLine ? (
            <Text style={styles.hostPlatformText} numberOfLines={1}>
              {hostDisplay.descriptorLine}
            </Text>
          ) : null}
        </View>
        {/* auth-failed has its own banner; the page cannot re-dial the connection the shell owns. */}
        {isConnectionOutage(connectionVerdict) && hostId && forceReconnectHost !== null ? (
          <Pressable
            style={styles.reconnectButton}
            onPress={() => void forceReconnectHost(hostId)}
            accessibilityRole="button"
            accessibilityLabel={t('hostScreen.hostScreenHeader.reconnect', 'Reconnect')}
            hitSlop={8}
          >
            <Text style={styles.reconnectButtonText}>
              {t('hostScreen.hostScreenHeader.reconnect', 'Reconnect')}
            </Text>
          </Pressable>
        ) : null}
        {!embedded && floatingWorkspaceEnabled && !railActions ? (
          <Pressable
            style={[
              styles.floatingWorkspaceHeaderButton,
              connState !== 'connected' && styles.toolbarIconDisabled
            ]}
            onPress={actions.openFloatingWorkspace}
            disabled={connState !== 'connected'}
            accessibilityRole="button"
            accessibilityLabel={t(
              'hostScreen.hostScreenHeader.floatingWorkspace',
              'Floating Workspace'
            )}
            hitSlop={8}
          >
            <SquareTerminal
              size={18}
              color={connState === 'connected' ? colors.textPrimary : colors.textMuted}
            />
          </Pressable>
        ) : null}
        {embedded && onHideSidebar ? (
          <Pressable
            style={styles.sidebarCollapseButton}
            onPress={onHideSidebar}
            accessibilityRole="button"
            accessibilityLabel={t('hostScreen.hostScreenHeader.hideSidebar', 'Hide sidebar')}
            hitSlop={8}
          >
            <PanelLeftClose size={14} color={colors.textSecondary} />
          </Pressable>
        ) : null}
      </View>

      {embedded ? (
        <View style={styles.embeddedToolbar}>
          <View style={styles.embeddedToolbarRow}>
            <Pressable
              style={[
                styles.filterChip,
                styles.embeddedFilterChip,
                controller.activeFilterCount > 0 && styles.filterChipActive
              ]}
              onPress={() => state.setShowWorkspaceOptions(true)}
              accessibilityRole="button"
              accessibilityLabel={workspaceOptionsAccessibilityLabel(
                t,
                controller.activeFilterCount
              )}
            >
              <Text
                style={[
                  styles.filterChipText,
                  controller.activeFilterCount > 0 && styles.filterChipTextActive
                ]}
                numberOfLines={1}
              >
                {t('hostScreen.hostScreenHeader.workspaceOptions', 'Workspace options')}
              </Text>
              <WorkspaceOptionsCountBadge count={controller.activeFilterCount} />
            </Pressable>
          </View>

          {railActions ? null : (
            <View style={styles.embeddedToolbarRow}>
              {hostListActions(controller, t).map((action) => (
                <Pressable
                  key={action.id}
                  style={[
                    styles.embeddedToolbarIconButton,
                    action.disabled && styles.toolbarIconDisabled
                  ]}
                  onPress={action.onPress}
                  disabled={action.disabled}
                  accessibilityRole="button"
                  accessibilityLabel={action.label}
                >
                  <action.icon
                    size={action.id === 'floating' ? 18 : 16}
                    color={
                      action.disabled
                        ? colors.textMuted
                        : action.id === 'new'
                          ? colors.textPrimary
                          : colors.textSecondary
                    }
                  />
                </Pressable>
              ))}
            </View>
          )}
        </View>
      ) : (
        <View style={styles.toolbar}>
          <Pressable
            style={[styles.filterChip, controller.activeFilterCount > 0 && styles.filterChipActive]}
            onPress={() => state.setShowWorkspaceOptions(true)}
            accessibilityRole="button"
            accessibilityLabel={workspaceOptionsAccessibilityLabel(t, controller.activeFilterCount)}
          >
            <Text
              style={[
                styles.filterChipText,
                controller.activeFilterCount > 0 && styles.filterChipTextActive
              ]}
            >
              {t('hostScreen.hostScreenHeader.workspaceOptions', 'Workspace options')}
            </Text>
            <WorkspaceOptionsCountBadge count={controller.activeFilterCount} />
          </Pressable>

          <View style={styles.toolbarSpacer} />
          {railActions ? null : (
            <>
              <Pressable
                style={styles.searchToggle}
                onPress={() =>
                  actions.navigateFromHostList(`/h/${encodeURIComponent(hostId)}/accounts`)
                }
                disabled={connState !== 'connected'}
                accessibilityRole="button"
                accessibilityLabel={t('hostScreen.hostScreenHeader.accounts', 'Accounts')}
              >
                <UserCircle
                  size={16}
                  color={connState === 'connected' ? colors.textSecondary : colors.textMuted}
                />
              </Pressable>

              <Pressable
                style={styles.searchToggle}
                onPress={() =>
                  actions.navigateFromHostList(`/h/${encodeURIComponent(hostId)}/tasks`)
                }
                disabled={connState !== 'connected'}
                accessibilityRole="button"
                accessibilityLabel={t('hostScreen.hostScreenHeader.tasks', 'Tasks')}
              >
                <List
                  size={16}
                  color={connState === 'connected' ? colors.textSecondary : colors.textMuted}
                />
              </Pressable>

              <Pressable
                style={styles.searchToggle}
                onPress={() => state.setShowSearch((s) => !s)}
                accessibilityRole="button"
                accessibilityLabel={
                  state.showSearch
                    ? t('hostScreen.hostScreenHeader.closeSearch', 'Close search')
                    : t('hostScreen.hostScreenHeader.searchWorkspaces', 'Search workspaces')
                }
              >
                {state.showSearch ? (
                  <X size={16} color={colors.textSecondary} />
                ) : (
                  <Search size={16} color={colors.textSecondary} />
                )}
              </Pressable>
            </>
          )}
        </View>
      )}
    </View>
  )
}
