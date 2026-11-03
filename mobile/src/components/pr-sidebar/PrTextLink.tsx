import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, Text } from 'react-native'
import { colors, feedback, pressedStyle } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

// A quiet text action under a comment, e.g. Reply, Resolve or Ask Claude to fix.
export function PrTextLink({
  label,
  onPress,
  busy = false,
  disabled = false,
  accent = false,
  icon
}: {
  label: string
  onPress: () => void
  busy?: boolean
  disabled?: boolean
  accent?: boolean
  icon?: ReactNode
}) {
  useMobileColorScheme()
  return (
    <Pressable
      onPress={onPress}
      disabled={busy || disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy, disabled }}
      style={({ pressed }) => [
        styles.link,
        disabled && styles.linkDisabled,
        pressed && pressedStyle
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={colors.textSecondary} /> : icon}
      <Text style={[styles.linkText, accent && styles.linkAccent]}>{label}</Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  link: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  linkText: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
  linkAccent: { color: colors.accentBlue },
  linkDisabled: { opacity: feedback.disabledOpacity }
}))
