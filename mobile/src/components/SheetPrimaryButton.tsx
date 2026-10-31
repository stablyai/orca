import { ActivityIndicator, Pressable, Text } from 'react-native'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

type SheetPrimaryButtonProps = {
  label: string
  onPress: () => void
  disabled?: boolean
  busy?: boolean
  testID?: string
}

/** A sheet's full-width commit at its foot, e.g. "Create worktree". */
export function SheetPrimaryButton({
  label,
  onPress,
  disabled = false,
  busy = false,
  testID
}: SheetPrimaryButtonProps) {
  useMobileColorScheme()
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        pressed && styles.pressed,
        disabled && !busy && styles.disabled
      ]}
      disabled={disabled || busy}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      testID={testID}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.bgBase} />
      ) : (
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      )}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  button: {
    height: 48,
    borderRadius: radii.control,
    backgroundColor: colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg
  },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.4 },
  label: { color: colors.bgBase, fontSize: 15, fontWeight: '600' }
}))
