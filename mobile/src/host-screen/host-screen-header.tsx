import { Pressable, Text, View } from 'react-native'
import {
  ChevronLeft,
  Filter,
  Layers,
  List,
  PanelLeftClose,
  Plus,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  UserCircle,
  X
} from 'lucide-react-native'
import { StatusDot } from '../components/StatusDot'
import { classifyConnection, type ConnectionVerdict } from '../transport/connection-health'
import { colors } from '../theme/mobile-theme'
import { hostScreenStyles as styles } from './host-screen-styles'
import type { HostScreenController } from './use-host-screen-controller'

function isErrorVerdict(v: ConnectionVerdict): boolean {
  return v.kind === 'warning' || v.kind === 'unreachable' || v.kind === 'auth-failed'
}

export function HostScreenHeader({ controller }: { controller: HostScreenController }) {
  const {
    actions,
    connState,
    embedded,
    floatingWorkspaceEnabled,
    forceReconnectHost,
    hostId,
    lastConnectedAt,
    onHideSidebar,
    reconnectAttempts,
    relayRecovery,
    settings,
    state
  } = controller

  return (
    <View style={styles.topChrome}>
      <View style={styles.statusBar}>
        <Pressable
          style={styles.backButton}
          onPress={actions.leaveHost}
          accessibilityRole="button"
          accessibilityLabel="Back to hosts"
          hitSlop={8}
        >
          <ChevronLeft size={22} color={colors.textPrimary} />
        </Pressable>
        {(() => {
          const headerVerdict = classifyConnection({
            state: connState,
            reconnectAttempts,
            lastConnectedAt,
            ...relayRecovery
          })
          return (
            <>
              <View style={styles.hostIdentity}>
                <StatusDot state={connState} verdict={headerVerdict} />
                <Text style={styles.hostNameText} numberOfLines={1}>
                  {state.hostName || 'Host'}
                </Text>
              </View>
              {connState !== 'connected' &&
                (() => {
                  // Why: auth-failed has its own banner, so suppress the Reconnect button for that verdict.
                  const verdict = headerVerdict
                  const isError = isErrorVerdict(verdict)
                  const showReconnectButton = isError && hostId && verdict.kind !== 'auth-failed'
                  if (!showReconnectButton) {
                    return null
                  }
                  return (
                    <Pressable
                      style={styles.reconnectButton}
                      onPress={() => void forceReconnectHost(hostId!)}
                      hitSlop={8}
                    >
                      <Text style={styles.reconnectButtonText}>Reconnect</Text>
                    </Pressable>
                  )
                })()}
            </>
          )
        })()}
        {!embedded && floatingWorkspaceEnabled ? (
          <Pressable
            style={[
              styles.floatingWorkspaceHeaderButton,
              connState !== 'connected' && styles.toolbarIconDisabled
            ]}
            onPress={actions.openFloatingWorkspace}
            disabled={connState !== 'connected'}
            accessibilityRole="button"
            accessibilityLabel="Floating Workspace"
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
            accessibilityLabel="Hide sidebar"
            hitSlop={8}
          >
            <PanelLeftClose size={14} color={colors.textSecondary} />
          </Pressable>
        ) : null}
      </View>

      {/* Filter/sort/group toolbar */}
      {embedded ? (
        <View style={styles.embeddedToolbar}>
          <View style={styles.embeddedToolbarRow}>
            <Pressable
              style={[
                styles.filterChip,
                styles.embeddedFilterChip,
                settings.activeFilterCount > 0 && styles.filterChipActive
              ]}
              onPress={() => state.setShowFilterModal(true)}
              accessibilityRole="button"
              accessibilityLabel={`Filter workspaces${settings.activeFilterCount > 0 ? `, ${settings.activeFilterCount} active` : ''}`}
            >
              <Filter
                size={12}
                color={settings.activeFilterCount > 0 ? colors.textPrimary : colors.textSecondary}
              />
              <Text
                style={[
                  styles.filterChipText,
                  settings.activeFilterCount > 0 && styles.filterChipTextActive
                ]}
                numberOfLines={1}
              >
                Filter{settings.activeFilterCount > 0 ? ` ${settings.activeFilterCount}` : ''}
              </Text>
            </Pressable>

            <Pressable
              style={[styles.modeButton, styles.embeddedModeButton]}
              onPress={() => state.setShowSortPicker(true)}
              accessibilityRole="button"
              accessibilityLabel={`Sort by ${settings.selectedSortLabel}`}
            >
              <SlidersHorizontal size={14} color={colors.textSecondary} />
              <Text style={styles.sortLabel} numberOfLines={1}>
                {settings.selectedSortLabel}
              </Text>
            </Pressable>

            <Pressable
              style={[styles.modeButton, styles.embeddedModeButton]}
              onPress={() => state.setShowGroupPicker(true)}
              accessibilityRole="button"
              accessibilityLabel="Group workspaces"
            >
              <Layers size={14} color={colors.textSecondary} />
              <Text style={styles.sortLabel} numberOfLines={1}>
                {state.groupMode === 'none'
                  ? 'Group'
                  : state.groupMode === 'workspaceStatus'
                    ? 'Status'
                    : state.groupMode === 'repo'
                      ? 'Repo'
                      : 'PR'}
              </Text>
            </Pressable>
          </View>

          <View style={styles.embeddedToolbarRow}>
            <Pressable
              style={[
                styles.embeddedToolbarIconButton,
                connState !== 'connected' && styles.toolbarIconDisabled
              ]}
              onPress={() => actions.navigateFromHostList(`/h/${hostId}/accounts`)}
              disabled={connState !== 'connected'}
              accessibilityRole="button"
              accessibilityLabel="Accounts"
            >
              <UserCircle
                size={16}
                color={connState === 'connected' ? colors.textSecondary : colors.textMuted}
              />
            </Pressable>

            <Pressable
              style={[
                styles.embeddedToolbarIconButton,
                connState !== 'connected' && styles.toolbarIconDisabled
              ]}
              onPress={() => actions.navigateFromHostList(`/h/${hostId}/tasks`)}
              disabled={connState !== 'connected'}
              accessibilityRole="button"
              accessibilityLabel="Tasks"
            >
              <List
                size={16}
                color={connState === 'connected' ? colors.textSecondary : colors.textMuted}
              />
            </Pressable>

            {floatingWorkspaceEnabled ? (
              <Pressable
                style={[
                  styles.embeddedToolbarIconButton,
                  connState !== 'connected' && styles.toolbarIconDisabled
                ]}
                onPress={actions.openFloatingWorkspace}
                disabled={connState !== 'connected'}
                accessibilityRole="button"
                accessibilityLabel="Floating Workspace"
              >
                <SquareTerminal
                  size={18}
                  color={connState === 'connected' ? colors.textSecondary : colors.textMuted}
                />
              </Pressable>
            ) : null}

            <Pressable
              style={[
                styles.embeddedToolbarIconButton,
                connState !== 'connected' && styles.toolbarIconDisabled
              ]}
              onPress={actions.openNewWorktreeModal}
              disabled={connState !== 'connected'}
              accessibilityRole="button"
              accessibilityLabel="New workspace"
            >
              <Plus
                size={16}
                color={connState === 'connected' ? colors.textPrimary : colors.textMuted}
              />
            </Pressable>

            <Pressable
              style={styles.embeddedToolbarIconButton}
              onPress={() => state.setShowSearch((s) => !s)}
              accessibilityRole="button"
              accessibilityLabel={state.showSearch ? 'Close search' : 'Search workspaces'}
            >
              {state.showSearch ? (
                <X size={16} color={colors.textSecondary} />
              ) : (
                <Search size={16} color={colors.textSecondary} />
              )}
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.toolbar}>
          <Pressable
            style={[styles.filterChip, settings.activeFilterCount > 0 && styles.filterChipActive]}
            onPress={() => state.setShowFilterModal(true)}
          >
            <Filter
              size={12}
              color={settings.activeFilterCount > 0 ? colors.textPrimary : colors.textSecondary}
            />
            <Text
              style={[
                styles.filterChipText,
                settings.activeFilterCount > 0 && styles.filterChipTextActive
              ]}
            >
              Filter{settings.activeFilterCount > 0 ? ` (${settings.activeFilterCount})` : ''}
            </Text>
          </Pressable>

          <Pressable style={styles.modeButton} onPress={() => state.setShowSortPicker(true)}>
            <SlidersHorizontal size={14} color={colors.textSecondary} />
            <Text style={styles.sortLabel} numberOfLines={1}>
              {settings.selectedSortLabel}
            </Text>
          </Pressable>

          <Pressable style={styles.modeButton} onPress={() => state.setShowGroupPicker(true)}>
            <Layers size={14} color={colors.textSecondary} />
            <Text style={styles.sortLabel} numberOfLines={1}>
              {state.groupMode === 'none'
                ? 'Group'
                : state.groupMode === 'workspaceStatus'
                  ? 'Status'
                  : state.groupMode === 'repo'
                    ? 'Repo'
                    : 'PR'}
            </Text>
          </Pressable>

          <View style={styles.toolbarSpacer} />

          <Pressable
            style={styles.searchToggle}
            onPress={() => actions.navigateFromHostList(`/h/${hostId}/accounts`)}
            disabled={connState !== 'connected'}
          >
            <UserCircle
              size={16}
              color={connState === 'connected' ? colors.textSecondary : colors.textMuted}
            />
          </Pressable>

          <Pressable
            style={styles.searchToggle}
            onPress={() => actions.navigateFromHostList(`/h/${hostId}/tasks`)}
            disabled={connState !== 'connected'}
          >
            <List
              size={16}
              color={connState === 'connected' ? colors.textSecondary : colors.textMuted}
            />
          </Pressable>

          <Pressable style={styles.searchToggle} onPress={() => state.setShowSearch((s) => !s)}>
            {state.showSearch ? (
              <X size={16} color={colors.textSecondary} />
            ) : (
              <Search size={16} color={colors.textSecondary} />
            )}
          </Pressable>
        </View>
      )}
    </View>
  )
}
