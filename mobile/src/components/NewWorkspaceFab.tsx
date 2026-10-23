import { Pressable, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Plus } from 'lucide-react-native'
import { colors, motion, spacing } from '../theme/mobile-theme'

// Diameter of the phone "new workspace" floating action button. Exported so the
// worktree list can reserve matching bottom padding and keep the last row tappable.
export const FAB_SIZE = 48

type NewWorkspaceFabProps = {
  onPress: () => void
  disabled?: boolean
}

// A floating "+" for creating a workspace. The worktree list no longer draws it (its "+" lives in
// the nav bar); kept for callers that want a floating create.
export function NewWorkspaceFab({ onPress, disabled }: NewWorkspaceFabProps): React.JSX.Element {
  const insets = useSafeAreaInsets()
  return (
    <Pressable
      style={({ pressed }) => [
        styles.fab,
        { bottom: spacing.xl + insets.bottom },
        pressed && styles.fabPressed,
        disabled && styles.fabDisabled
      ]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel="New workspace"
      hitSlop={8}
    >
      <Plus size={24} color={colors.onPrimary} strokeWidth={2.5} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: spacing.lg,
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary
  },
  fabPressed: {
    backgroundColor: colors.primaryPressed,
    transform: [{ scale: motion.pressedIconScale }]
  },
  fabDisabled: {
    opacity: motion.disabledOpacity
  }
})
