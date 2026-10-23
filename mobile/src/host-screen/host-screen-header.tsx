import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import {
  Ellipsis,
  ListTodo,
  PanelLeftClose,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  SquareTerminal,
  UserCircle
} from 'lucide-react-native'
import { ActionSheetModal, type ActionSheetAction } from '../components/ActionSheetModal'
import { MobileSearchField } from '../components/MobileSearchField'
import { statusDotColor } from '../components/StatusDot'
import { IconButton } from '../components/ui/IconButton'
import { LargeTitle, NavBar } from '../components/ui/NavBar'
import {
  classifyConnection,
  verdictDisplayLabel,
  type ConnectionVerdict
} from '../transport/connection-health'
import type { ConnectionState } from '../transport/types'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import { workspaceOptionsAccessibilityLabel } from '../worktree/workspace-options-copy'
import { WorkspaceOptionsCountBadge } from './workspace-options-count-badge'
import type { HostScreenController } from './use-host-screen-controller'

function isErrorVerdict(v: ConnectionVerdict): boolean {
  return v.kind === 'warning' || v.kind === 'unreachable' || v.kind === 'auth-failed'
}

/** The header's reading of the connection, shared by the bar, the large title and the list states. */
export function hostHeaderVerdict(controller: HostScreenController): ConnectionVerdict {
  return classifyConnection({
    state: controller.connState,
    reconnectAttempts: controller.reconnectAttempts,
    lastConnectedAt: controller.lastConnectedAt,
    hostName: controller.state.hostName,
    ...controller.relayRecovery
  })
}

/** "Connected · 6 workspaces", or the verdict in words while the desktop is away. */
export function hostStatusLabel(
  connState: ConnectionState,
  verdict: ConnectionVerdict,
  workspaceCount: number
): string {
  if (connState === 'connected' && verdict.kind === 'normal') {
    return workspaceCount > 0
      ? `Connected · ${workspaceCount} ${workspaceCount === 1 ? 'workspace' : 'workspaces'}`
      : 'Connected'
  }
  return verdictDisplayLabel(verdict)
}

/** The nav bar: back, the "…" menu (Tasks, Accounts, Floating Workspace) and the one "+". */
export function HostScreenHeader({
  controller,
  titleVisible = true,
  scrolled = false
}: {
  controller: HostScreenController
  /** False while the large title in the list still shows the desktop's name. */
  titleVisible?: boolean
  scrolled?: boolean
}) {
  const {
    actions,
    connState,
    embedded,
    floatingWorkspaceEnabled,
    forceReconnectHost,
    hostId,
    hostDisplay,
    onHideSidebar
  } = controller
  const [menuOpen, setMenuOpen] = useState(false)
  const verdict = hostHeaderVerdict(controller)
  const connected = connState === 'connected'
  const status = hostStatusLabel(connState, verdict, controller.displayWorktrees.length)
  const whenConnected = connected ? undefined : 'Available once the desktop is connected.'

  const menu: ActionSheetAction[] = [
    {
      label: 'Tasks',
      icon: ListTodo,
      disabled: !connected,
      hint: whenConnected,
      onPress: () => actions.navigateFromHostList(`/h/${encodeURIComponent(hostId)}/tasks`)
    },
    {
      label: 'Accounts',
      icon: UserCircle,
      disabled: !connected,
      hint: whenConnected,
      onPress: () => actions.navigateFromHostList(`/h/${encodeURIComponent(hostId)}/accounts`)
    }
  ]
  if (floatingWorkspaceEnabled) {
    menu.push({
      label: 'Floating Workspace',
      icon: SquareTerminal,
      disabled: !connected,
      hint: whenConnected,
      onPress: actions.openFloatingWorkspace
    })
  }
  // Native only: on the page the shell owns the connection and nothing here re-dials.
  // Why: auth-failed has its own banner, so Reconnect stays out of the menu for that verdict.
  if (
    !connected &&
    isErrorVerdict(verdict) &&
    verdict.kind !== 'auth-failed' &&
    hostId &&
    forceReconnectHost !== null
  ) {
    menu.push({
      label: 'Reconnect',
      icon: RefreshCw,
      onPress: () => void forceReconnectHost(hostId)
    })
  }
  if (embedded && onHideSidebar) {
    menu.push({
      label: 'Hide sidebar',
      icon: PanelLeftClose,
      onPress: onHideSidebar
    })
  }

  return (
    <>
      <NavBar
        title={hostDisplay.title}
        subtitle={status}
        subtitleColor={connected ? undefined : statusDotColor(connState, verdict)}
        titleVisible={titleVisible}
        scrolled={scrolled}
        onBack={actions.leaveHost}
        backAccessibilityLabel="Back to desktops"
        trailing={
          <>
            <IconButton
              icon={Ellipsis}
              accessibilityLabel="More"
              onPress={() => setMenuOpen(true)}
            />
            {embedded ? (
              <IconButton
                icon={Plus}
                variant="primary"
                accessibilityLabel="New workspace"
                onPress={actions.openNewWorktreeModal}
                disabled={!connected}
              />
            ) : null}
          </>
        }
      />
      <ActionSheetModal
        visible={menuOpen}
        title={hostDisplay.title}
        actions={menu}
        onClose={() => setMenuOpen(false)}
      />
    </>
  )
}

/**
 * The large title and its status line. In the sidebar, search and Workspace options sit under it;
 * on a phone they live in the bottom toolbar, and the title folds into the bar while searching.
 */
export function HostListTitle({
  controller,
  searchActive = false
}: {
  controller: HostScreenController
  searchActive?: boolean
}) {
  const { connState, embedded, hostDisplay, state } = controller
  const verdict = hostHeaderVerdict(controller)
  const status = hostStatusLabel(connState, verdict, controller.displayWorktrees.length)
  if (!embedded && searchActive) {
    return null
  }
  return (
    <View style={styles.titleBlock}>
      <LargeTitle
        title={hostDisplay.title}
        subtitle={
          <View style={styles.statusLine}>
            <View style={[styles.dot, { backgroundColor: statusDotColor(connState, verdict) }]} />
            <Text style={styles.statusText} numberOfLines={2}>
              {hostDisplay.descriptorLine ? `${status} · ${hostDisplay.descriptorLine}` : status}
            </Text>
          </View>
        }
      />
      {embedded ? (
        <View style={styles.searchRow}>
          <View style={styles.searchField}>
            <MobileSearchField
              value={state.search}
              onChangeText={state.setSearch}
              placeholder="Search workspaces"
              accessibilityLabel="Search workspaces"
            />
          </View>
          <View>
            <IconButton
              icon={SlidersHorizontal}
              iconSize={18}
              accessibilityLabel={workspaceOptionsAccessibilityLabel(controller.activeFilterCount)}
              selected={controller.activeFilterCount > 0}
              onPress={() => state.setShowWorkspaceOptions(true)}
            />
            <WorkspaceOptionsCountBadge count={controller.activeFilterCount} />
          </View>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  titleBlock: { paddingTop: 2, paddingBottom: spacing.xs },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: {
    ...textStyles.callout,
    color: colors.textSecondary,
    flexShrink: 1
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingLeft: spacing.lg,
    paddingRight: spacing.md,
    paddingTop: spacing.md
  },
  searchField: { flex: 1, minWidth: 0 }
})
