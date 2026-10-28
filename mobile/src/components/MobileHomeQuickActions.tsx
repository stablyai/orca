import { Plus, QrCode } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import type { HostProfile } from '../transport/types'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

type Props = {
  connectedHosts: HostProfile[]
  onPairDesktop: () => void
  onCreateWorkspace: () => void
}

export function MobileHomeQuickActions(props: Props) {
  useMobileColorScheme()
  const canCreateWorkspace = props.connectedHosts.length > 0

  return (
    <>
      <Text style={styles.sectionHeading}>Quick Actions</Text>
      <View style={styles.quickActions}>
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.quickAction, pressed && styles.quickActionPressed]}
          onPress={props.onPairDesktop}
        >
          <View style={styles.quickActionIcon}>
            <QrCode size={16} color={colors.textSecondary} />
          </View>
          <Text style={styles.quickActionLabel}>Pair Desktop</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canCreateWorkspace }}
          disabled={!canCreateWorkspace}
          style={({ pressed }) => [
            styles.quickAction,
            !canCreateWorkspace && styles.quickActionDisabled,
            pressed && styles.quickActionPressed
          ]}
          onPress={props.onCreateWorkspace}
        >
          <View style={styles.quickActionIcon}>
            <Plus size={16} color={colors.textSecondary} />
          </View>
          <Text style={styles.quickActionLabel}>New Workspace</Text>
        </Pressable>
      </View>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  sectionHeading: {
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs,
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6
  },
  quickActions: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  quickAction: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel
  },
  quickActionPressed: {
    backgroundColor: colors.bgRaised
  },
  quickActionDisabled: {
    opacity: 0.45
  },
  quickActionIcon: {
    width: 28,
    height: 28,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  quickActionLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600'
  }
}))
