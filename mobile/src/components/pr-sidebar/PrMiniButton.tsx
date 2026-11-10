import { ActivityIndicator, Pressable, Text } from 'react-native'
import type { LucideIcon } from 'lucide-react-native'
import { colors, feedback, pressedStyle, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

export function PrMiniButton({
  icon: Icon,
  label,
  onPress,
  busy = false,
  disabled = false,
  bright = false
}: {
  icon?: LucideIcon
  label: string
  onPress: () => void
  busy?: boolean
  disabled?: boolean
  bright?: boolean
}) {
  useMobileColorScheme()
  const color = bright ? colors.bgBase : colors.textPrimary
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        bright && styles.bright,
        disabled && styles.disabled,
        pressed && pressedStyle
      ]}
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
    >
      {busy ? (
        <ActivityIndicator size="small" color={color} />
      ) : Icon ? (
        <Icon size={14} color={color} strokeWidth={2.2} />
      ) : null}
      <Text style={[styles.label, { color }]}>{label}</Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.bgRaised
  },
  bright: { backgroundColor: colors.surfaceBright },
  label: { fontSize: 13, fontWeight: '600' },
  disabled: { opacity: feedback.disabledOpacity }
}))
