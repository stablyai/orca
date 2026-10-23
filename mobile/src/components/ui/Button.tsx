import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import type { LucideIcon } from 'lucide-react-native'
import { colors, MIN_TOUCH_TARGET, motion, radii, textStyles } from '../../theme/mobile-theme'
import { pressTransition } from './transition-styles'

export type ButtonVariant = 'primary' | 'secondary' | 'plain' | 'destructive'
export type ButtonSize = 'large' | 'compact'

type ButtonProps = {
  label: string
  onPress: () => void
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: LucideIcon
  /** Keeps the button's width and shows a spinner where the icon sits. */
  busy?: boolean
  disabled?: boolean
  /** Stretches to the container's width. */
  block?: boolean
  accessibilityLabel?: string
  accessibilityHint?: string
  testID?: string
  style?: StyleProp<ViewStyle>
}

const FILL: Record<ButtonVariant, { rest: string; pressed: string }> = {
  primary: { rest: colors.primary, pressed: colors.primaryPressed },
  secondary: { rest: colors.fill, pressed: colors.fillPressed },
  plain: { rest: 'transparent', pressed: colors.fill },
  destructive: { rest: colors.fill, pressed: colors.fillPressed }
}

const LABEL: Record<ButtonVariant, string> = {
  primary: colors.onPrimary,
  secondary: colors.textPrimary,
  plain: colors.textPrimary,
  destructive: colors.danger
}

/**
 * The app's button: two sizes, four variants, one press. Use one primary per screen or sheet.
 * The compact size still lays out a 44 pt touch box around its 36 pt pill.
 */
export function Button({
  label,
  onPress,
  variant = 'secondary',
  size = 'large',
  icon: Icon,
  busy = false,
  disabled = false,
  block = false,
  accessibilityLabel,
  accessibilityHint,
  testID,
  style
}: ButtonProps) {
  const compact = size === 'compact'
  const labelColor = LABEL[variant]
  const leading = busy || Icon !== undefined
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || busy, busy }}
      testID={testID}
      style={[styles.touch, block && styles.block, disabled && styles.disabled, style]}
    >
      {({ pressed }) => (
        <View
          style={[
            compact ? styles.compact : styles.large,
            leading && (compact ? styles.compactLeading : styles.largeLeading),
            { backgroundColor: pressed ? FILL[variant].pressed : FILL[variant].rest },
            pressed ? styles.pressed : null,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={labelColor} />
          ) : Icon ? (
            <Icon size={compact ? 16 : 18} color={labelColor} strokeWidth={2.2} />
          ) : null}
          <Text
            style={[compact ? styles.compactLabel : styles.largeLabel, { color: labelColor }]}
            numberOfLines={1}
          >
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  touch: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    alignSelf: 'flex-start'
  },
  block: { alignSelf: 'stretch' },
  disabled: { opacity: motion.disabledOpacity },
  large: {
    height: 50,
    borderRadius: radii.pill,
    paddingHorizontal: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8
  },
  largeLeading: { paddingLeft: 18 },
  compact: {
    height: 36,
    borderRadius: radii.pill,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6
  },
  compactLeading: { paddingLeft: 12 },
  pressed: { transform: [{ scale: motion.pressedScale }] },
  largeLabel: { ...textStyles.body, fontWeight: '600' },
  compactLabel: { ...textStyles.callout, fontWeight: '500' }
})
