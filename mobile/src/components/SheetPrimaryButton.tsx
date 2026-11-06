import { ActivityIndicator, Pressable, Text } from 'react-native'
import type { LucideIcon } from 'lucide-react-native'
import { colors, feedback, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

type SheetPrimaryButtonProps = {
  label: string
  onPress: () => void
  disabled?: boolean
  busy?: boolean
  testID?: string
  /** Merge keeps desktop's merge green for the one action that lands a pull request. */
  tone?: 'default' | 'merge'
  icon?: LucideIcon
}

/** A sheet's full-width commit at its foot, e.g. "Create worktree". */
export function SheetPrimaryButton({
  label,
  onPress,
  disabled = false,
  busy = false,
  testID,
  tone = 'default',
  icon: Icon
}: SheetPrimaryButtonProps) {
  useMobileColorScheme()
  const foreground = tone === 'merge' ? colors.onMergeGreen : colors.bgBase
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        tone === 'merge' && styles.merge,
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
        <ActivityIndicator size="small" color={foreground} />
      ) : (
        <>
          {Icon ? <Icon size={17} color={foreground} strokeWidth={2.2} /> : null}
          <Text style={[styles.label, { color: foreground }]} numberOfLines={1}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  button: {
    height: 48,
    borderRadius: radii.control,
    backgroundColor: colors.textPrimary,
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg
  },
  merge: { backgroundColor: colors.mergeGreen },
  pressed: { opacity: feedback.pressedOpacity },
  disabled: { opacity: feedback.disabledOpacity },
  label: { color: colors.bgBase, fontSize: 15, fontWeight: '600' }
}))
