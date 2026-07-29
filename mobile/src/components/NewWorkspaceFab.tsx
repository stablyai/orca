import { Pressable, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Plus } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'

// Diameter of the phone "new workspace" floating action button. Exported so the
// worktree list can reserve matching bottom padding and keep the last row tappable.
export const FAB_SIZE = 48

type NewWorkspaceFabProps = {
  onPress: () => void
  disabled?: boolean
}

// Phone-only floating "+" for creating a workspace. Absolutely positioned so it
// never intercepts list row taps, and lifted above the home indicator.
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
      <Plus size={24} color={colors.bgBase} strokeWidth={2.75} />
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
    // Crisp near-white surface + dark icon: high contrast against the dark canvas
    // reads as the primary action while staying monochrome (STYLEGUIDE: color is
    // for state). Tight shadow avoids the muddy halo that made it look disabled.
    backgroundColor: colors.surfaceBright,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4
  },
  fabPressed: {
    backgroundColor: colors.textPrimary
  },
  fabDisabled: {
    opacity: 0.5
  }
})
