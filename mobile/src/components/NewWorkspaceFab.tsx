import { Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Plus } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

// Export diameter so worktree list reserves matching padding and last row stays tappable.
export const FAB_SIZE = 48

type NewWorkspaceFabProps = {
  onPress: () => void
  disabled?: boolean
}

// Phone-only FAB sits above home indicator and outside list-row hit area.
export function NewWorkspaceFab({ onPress, disabled }: NewWorkspaceFabProps): React.JSX.Element {
  useMobileColorScheme()
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

const styles = themedStyleSheet(() => ({
  fab: {
    position: 'absolute',
    right: spacing.lg,
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    // High-contrast monochrome primary action; tight shadow avoids disabled-looking halo (STYLEGUIDE reserves color for state).
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
}))
