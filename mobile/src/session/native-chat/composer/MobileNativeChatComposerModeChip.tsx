import { Pressable, Text } from 'react-native'
import { X, type LucideIcon } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  COMPOSER_CONTROL_SIZE,
  composerInputStyles
} from '../../../components/composer-input/composer-input-styles'

/** Touch has no hover, so the exit affordance always shows. */
export function MobileNativeChatComposerModeChip({
  icon: Icon,
  label,
  exitLabel,
  testID,
  disabled = false,
  onExit
}: {
  icon: LucideIcon
  label: string
  exitLabel: string
  testID: string
  disabled?: boolean
  onExit: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={exitLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      style={({ pressed }) => [
        styles.chip,
        disabled && composerInputStyles.disabled,
        pressed && composerInputStyles.pressed
      ]}
      onPress={onExit}
      testID={testID}
    >
      <Icon size={15} color={colors.textPrimary} strokeWidth={2} />
      <Text style={styles.label}>{label}</Text>
      <X size={14} color={colors.textMuted} strokeWidth={2} />
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  chip: {
    height: COMPOSER_CONTROL_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.translucentFill,
    flexShrink: 0
  },
  label: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  }
}))
