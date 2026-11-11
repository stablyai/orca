import type { ComponentType, Ref } from 'react'
import { Pressable, Text, View } from 'react-native'
import { colors, feedback, radii } from '../../theme/mobile-theme'
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
  /** The icon's colour while not active, e.g. a PR state's. */
  iconColor?: string
  /** A needs-you count drawn on the button's corner; hidden at zero. */
  badge?: number
}

// A round top-bar button; the bar floats over content like the composer, so its buttons are round too.
export function NavBarButton({
  ref,
  icon: Icon,
  accessibilityLabel,
  onPress,
  active = false,
  disabled = false,
  iconColor,
  badge = 0
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
      <Icon
        size={18}
        color={active ? colors.bgBase : (iconColor ?? colors.textPrimary)}
        strokeWidth={2.1}
      />
      {badge > 0 ? (
        <View style={styles.badge} pointerEvents="none">
          <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
        </View>
      ) : null}
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
  },
  // The Agents tab's needs-you badge.
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.statusAmber,
    borderWidth: 1.5,
    borderColor: colors.bgBase
  },
  badgeText: { fontSize: 11, fontWeight: '700', color: '#000' }
}))
