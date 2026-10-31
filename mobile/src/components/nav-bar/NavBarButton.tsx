import type { ComponentType, Ref } from 'react'
import { Pressable, type View } from 'react-native'
import { colors, radii } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

export const NAV_BAR_BUTTON_SIZE = 36

type IconProps = { size?: number; color?: string; strokeWidth?: number }

type NavBarButtonProps = {
  ref?: Ref<View>
  icon: ComponentType<IconProps>
  accessibilityLabel: string
  onPress: () => void
  /** The screen or panel this button opens is showing. */
  active?: boolean
  disabled?: boolean
}

// A round top-bar button; the bar floats over content like the composer, so its buttons are round too.
export function NavBarButton({
  ref,
  icon: Icon,
  accessibilityLabel,
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
      accessibilityState={{ disabled, selected: active }}
    >
      <Icon size={18} color={active ? colors.bgBase : colors.textPrimary} strokeWidth={2.1} />
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
    opacity: 0.7
  },
  disabled: {
    opacity: 0.4
  }
}))
