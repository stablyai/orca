import type { ComponentType, ReactNode, Ref } from 'react'
import { Pressable, type View } from 'react-native'
import { colors, feedback, radii } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

export const NAV_BAR_BUTTON_SIZE = 36

type IconProps = { size?: number; color?: string; strokeWidth?: number }

type NavBarButtonProps = {
  ref?: Ref<View>
  accessibilityLabel: string
  accessibilityHint?: string
  onPress: () => void
  /** The screen or panel this button opens is showing. */
  active?: boolean
  disabled?: boolean
} & (
  | { icon: ComponentType<IconProps>; children?: never }
  /** Drawn in place of an icon, e.g. a tab count. */
  | { icon?: never; children: ReactNode }
)

// A round top-bar button; the bar floats over content like the composer, so its buttons are round too.
export function NavBarButton({
  ref,
  icon: Icon,
  children,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  active = false,
  disabled = false
}: NavBarButtonProps) {
  useMobileColorScheme()
  return (
    <Pressable
      ref={ref}
      style={({ pressed }) => [
        styles.button,
        active && styles.active,
        pressed && styles.pressed,
        disabled && styles.disabled
      ]}
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, selected: active }}
    >
      {Icon ? (
        <Icon size={18} color={active ? colors.bgBase : colors.textPrimary} strokeWidth={2.1} />
      ) : (
        children
      )}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  button: {
    width: NAV_BAR_BUTTON_SIZE,
    height: NAV_BAR_BUTTON_SIZE,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  active: {
    backgroundColor: colors.surfaceBright
  },
  pressed: {
    opacity: feedback.pressedOpacity
  },
  disabled: {
    opacity: feedback.disabledOpacity
  }
}))
