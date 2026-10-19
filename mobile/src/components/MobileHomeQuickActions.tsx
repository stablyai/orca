import { Plus, QrCode } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { HostProfile } from '../transport/types'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { PickerModal } from './PickerModal'
import { useConnectedHostPicker } from './use-connected-host-picker'

type Props = {
  connectedHosts: HostProfile[]
  onPairDesktop: () => void
  onCreateWorkspace: (hostId: string) => void
}

export function MobileHomeQuickActions(props: Props) {
  const hostPicker = useConnectedHostPicker(props.connectedHosts)
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
          onPress={() => hostPicker.pickHost(props.onCreateWorkspace)}
        >
          <View style={styles.quickActionIcon}>
            <Plus size={16} color={colors.textSecondary} />
          </View>
          <Text style={styles.quickActionLabel}>New Workspace</Text>
        </Pressable>
      </View>
      <PickerModal title="Create Workspace On" {...hostPicker.pickerProps} />
    </>
  )
}

const styles = StyleSheet.create({
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
})
