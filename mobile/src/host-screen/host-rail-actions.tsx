import { Pressable, StyleSheet, View } from 'react-native'
import {
  List,
  Plus,
  Search,
  SquareTerminal,
  UserCircle,
  X,
  type LucideIcon
} from 'lucide-react-native'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { colors, spacing } from '../theme/mobile-theme'
import type { HostScreenController } from './use-host-screen-controller'

type HostListAction = {
  id: 'accounts' | 'tasks' | 'search' | 'floating' | 'new'
  label: string
  icon: LucideIcon
  onPress: () => void
  disabled: boolean
}

// One list for the sidebar's toolbar row and the side rail, so both offer the same actions.
export function hostListActions(controller: HostScreenController): HostListAction[] {
  const { actions, connState, floatingWorkspaceEnabled, hostId, state } = controller
  const offline = connState !== 'connected'
  const hostPath = `/h/${encodeURIComponent(hostId)}`
  return [
    {
      id: 'accounts',
      label: 'Accounts',
      icon: UserCircle,
      onPress: () => actions.navigateFromHostList(`${hostPath}/accounts`),
      disabled: offline
    },
    {
      id: 'tasks',
      label: 'Tasks',
      icon: List,
      onPress: () => actions.navigateFromHostList(`${hostPath}/tasks`),
      disabled: offline
    },
    ...(floatingWorkspaceEnabled
      ? [
          {
            id: 'floating' as const,
            label: 'Floating Workspace',
            icon: SquareTerminal,
            onPress: actions.openFloatingWorkspace,
            disabled: offline
          }
        ]
      : []),
    {
      id: 'new',
      label: 'New workspace',
      icon: Plus,
      onPress: actions.openNewWorktreeModal,
      disabled: offline
    },
    {
      id: 'search',
      label: state.showSearch ? 'Close search' : 'Search workspaces',
      icon: state.showSearch ? X : Search,
      onPress: () => state.setShowSearch((shown) => !shown),
      disabled: false
    }
  ]
}

function RailIcon({ action }: { action: HostListAction }) {
  useMobileColorScheme()
  return (
    <Pressable
      style={({ pressed }) => [
        styles.icon,
        pressed && styles.pressed,
        action.disabled && styles.disabled
      ]}
      onPress={action.onPress}
      disabled={action.disabled}
      accessibilityRole="button"
      accessibilityLabel={action.label}
    >
      <action.icon size={22} color={colors.textSecondary} />
    </Pressable>
  )
}

function pick(all: HostListAction[], ids: HostListAction['id'][]): HostListAction[] {
  return ids.flatMap((id) => all.filter((action) => action.id === id))
}

// Beside the sidebar: navigation, then the workspace tools, then New as the one filled button.
// On the cover the list keeps its own New button, and search sits at the bottom within thumb reach.
export function HostRailActions({
  controller,
  placement
}: {
  controller: HostScreenController
  placement: 'split' | 'cover'
}) {
  useMobileColorScheme()
  const all = hostListActions(controller)
  if (placement === 'cover') {
    return (
      <View style={styles.coverRail}>
        <View style={styles.rail}>
          {pick(all, ['accounts', 'tasks', 'floating']).map((action) => (
            <RailIcon key={action.id} action={action} />
          ))}
        </View>
        {pick(all, ['search']).map((action) => (
          <RailIcon key={action.id} action={action} />
        ))}
      </View>
    )
  }
  const create = all.find((action) => action.id === 'new')
  return (
    <View style={styles.rail}>
      {pick(all, ['accounts', 'tasks', 'search', 'floating']).map((action) => (
        <View key={action.id} style={styles.rail}>
          {action.id === 'floating' ? <View style={styles.divider} /> : null}
          <RailIcon action={action} />
        </View>
      ))}
      {create ? (
        <Pressable
          style={({ pressed }) => [
            styles.create,
            pressed && styles.createPressed,
            create.disabled && styles.disabled
          ]}
          onPress={create.onPress}
          disabled={create.disabled}
          accessibilityRole="button"
          accessibilityLabel={create.label}
        >
          <Plus size={24} color={colors.bgBase} strokeWidth={2.2} />
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  rail: {
    alignItems: 'center',
    gap: spacing.sm
  },
  coverRail: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: spacing.sm
  },
  icon: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22
  },
  pressed: {
    backgroundColor: colors.bgRaised
  },
  disabled: {
    opacity: 0.4
  },
  divider: {
    width: 32,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle
  },
  create: {
    marginTop: spacing.xs,
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceBright
  },
  createPressed: {
    opacity: 0.85
  }
}))
