import { createContext, useContext, type ComponentType, type Ref } from 'react'
import { Pressable, Text, View, type HostInstance } from 'react-native'
import { colors, feedback, radii } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

export const NAV_BAR_BUTTON_SIZE = 36

/** Set by a bar on light grey (a sheet's header, a grouped page): bgRaised is that grey, so its buttons take a fill that reads on it. */
export const NavBarButtonOnSheetContext = createContext(false)

type IconProps = { size?: number; color?: string; strokeWidth?: number }

type NavBarButtonProps = {
  ref?: Ref<HostInstance>
  icon: ComponentType<IconProps>
  accessibilityLabel: string
  onPress: () => void
  /** The screen or panel this button opens is showing. */
  active?: boolean
  disabled?: boolean
  /** The icon's colour while not active, e.g. a PR state's. */
  iconColor?: string
  /** A count on the button's corner, e.g. items that need you; nothing at 0. */
  badge?: { count: number; color: string }
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
  badge
}: NavBarButtonProps) {
  useMobileColorScheme()
  const onSheet = useContext(NavBarButtonOnSheetContext)
  return (
    <Pressable
      ref={ref}
      style={({ pressed }) => [
        styles.button,
        onSheet && styles.onSheet,
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
      {badge && badge.count > 0 ? (
        <View style={[styles.badge, { backgroundColor: badge.color }]}>
          <Text style={styles.badgeText}>{badge.count > 99 ? '99+' : badge.count}</Text>
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
  onSheet: { backgroundColor: colors.cardPillFill },
  active: {
    backgroundColor: colors.surfaceBright
  },
  pressed: {
    opacity: feedback.pressedOpacity
  },
  disabled: {
    opacity: feedback.disabledOpacity
  },
  badge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.bgBase
  },
  badgeText: { fontSize: 10, fontWeight: '700', color: '#ffffff', lineHeight: 12 }
}))
