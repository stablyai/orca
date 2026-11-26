import { Pressable, Text } from 'react-native'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export function CommanderSegment({
  label,
  selected,
  onPress
}: {
  label: string
  selected: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      aria-selected={selected}
      onPress={onPress}
      style={[styles.segment, selected && styles.selected]}
    >
      <Text style={[styles.secondary, selected && styles.strong]}>{label}</Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  segment: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control
  },
  selected: { backgroundColor: colors.bgRaised },
  strong: { fontSize: 16, fontWeight: '600', color: colors.textPrimary },
  secondary: { fontSize: 14, color: colors.textSecondary }
}))
