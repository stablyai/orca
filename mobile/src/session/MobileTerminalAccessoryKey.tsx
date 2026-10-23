import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native'
import type { LucideIcon } from 'lucide-react-native'
import { pressTransition } from '../components/ui/transition-styles'
import { triggerSelection } from '../platform/haptics'
import {
  colors,
  MIN_TOUCH_TARGET,
  motion,
  radii,
  textStyles,
  typography
} from '../theme/mobile-theme'

type Props = {
  label?: string
  icon?: LucideIcon
  /** Drawn instead of the icon, e.g. the keyboard-with-chevron glyph. */
  glyph?: ReactNode
  /** A key whose label is a word rather than a key cap, e.g. "Phone" or "Live". */
  sans?: boolean
  /** On: the key's mode is engaged, e.g. live input. */
  active?: boolean
  /** A user-made key, edged so it reads apart from the built-in ones. */
  custom?: boolean
  disabled?: boolean
  onPress?: () => void
  onPressIn?: () => void
  onPressOut?: () => void
  onLongPress?: (event: GestureResponderEvent) => void
  delayLongPress?: number
  accessibilityLabel: string
  accessibilityHint?: string
  testID?: string
}

/** One accessory key: a 38 pt capsule in a 44 pt touch box, 15 pt label, a tick on every press. */
export function MobileTerminalAccessoryKey({
  label,
  icon: Icon,
  glyph,
  sans = false,
  active = false,
  custom = false,
  disabled = false,
  onPress,
  onPressIn,
  onPressOut,
  onLongPress,
  delayLongPress,
  accessibilityLabel,
  accessibilityHint,
  testID
}: Props) {
  const tint = colors.textPrimary
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => {
        triggerSelection()
        onPressIn?.()
      }}
      onPressOut={onPressOut}
      onLongPress={onLongPress}
      delayLongPress={delayLongPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={active ? { disabled, selected: true } : { disabled }}
      testID={testID}
      style={[styles.touch, disabled && styles.disabled]}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.key,
            label !== undefined && (Icon || glyph) ? styles.keyWithIcon : null,
            custom && styles.custom,
            active && styles.active,
            pressed && styles.pressed,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          {glyph ?? (Icon ? <Icon size={17} color={tint} strokeWidth={2.1} /> : null)}
          {label !== undefined ? (
            <Text
              style={[sans ? styles.sansLabel : styles.label, { color: tint }]}
              numberOfLines={1}
            >
              {label}
            </Text>
          ) : null}
        </View>
      )}
    </Pressable>
  )
}

const KEY_HEIGHT = 38

const styles = StyleSheet.create({
  touch: { height: MIN_TOUCH_TARGET, justifyContent: 'center' },
  disabled: { opacity: motion.disabledOpacity },
  key: {
    height: KEY_HEIGHT,
    minWidth: 44,
    paddingHorizontal: 14,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: colors.fill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6
  },
  keyWithIcon: { paddingLeft: 11 },
  custom: { borderColor: colors.fieldBorder },
  active: { backgroundColor: colors.fillPressed, borderColor: colors.fieldBorderFocused },
  pressed: { backgroundColor: colors.fillPressed, transform: [{ scale: motion.pressedIconScale }] },
  label: {
    fontFamily: typography.monoFamily,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '500'
  },
  sansLabel: { ...textStyles.callout, fontWeight: '500' }
})
