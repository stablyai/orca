import { Pressable, Text } from 'react-native'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export function MemoryButton({
  label,
  onPress,
  disabled = false,
  primary = false,
  selected
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  primary?: boolean
  selected?: boolean
}) {
  useMobileColorScheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        primary && s.primary,
        selected && s.selected,
        (pressed || disabled) && s.dim
      ]}
    >
      <Text style={[s.buttonText, primary && s.primaryText]}>{label}</Text>
    </Pressable>
  )
}

export const s = themedStyleSheet(() => ({
  fill: { flex: 1 },
  hidden: { display: 'none' },
  stack: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  field: {
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.inputBorder,
    borderRadius: radii.control,
    minHeight: 44,
    padding: spacing.sm,
    fontSize: 16
  },
  editor: { minHeight: 140, textAlignVertical: 'top' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, alignItems: 'center' },
  item: {
    paddingVertical: spacing.sm,
    minHeight: 48,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    justifyContent: 'center'
  },
  heading: { fontSize: 20, fontWeight: '600', color: colors.textPrimary },
  title: { fontSize: 16, fontWeight: '600', color: colors.textPrimary },
  body: { fontSize: 16, lineHeight: 24, color: colors.textPrimary },
  meta: { fontSize: 14, lineHeight: 20, color: colors.textSecondary },
  button: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radii.control,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.bgRaised
  },
  selected: { borderWidth: 1, borderColor: colors.inputBorder },
  primary: { backgroundColor: colors.surfaceBright },
  buttonText: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  primaryText: { color: colors.bgBase },
  dim: { opacity: 0.55 },
  bottom: { paddingBottom: spacing.xl }
}))
