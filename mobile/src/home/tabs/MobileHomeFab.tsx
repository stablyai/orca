import { Plus } from 'lucide-react-native'
import { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useReducedMotionEnabled } from '../../platform/accessibility/use-reduced-motion'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { HOME_EASE_OUT } from './home-tabs'

const SIZE = 56

/**
 * The tab's one creating action, floating bottom-right above the tab bar.
 * It scales in from 0.9 when a tab gains it and fades out when one loses it.
 */
export function MobileHomeFab(props: {
  visible: boolean
  disabled: boolean
  accessibilityLabel: string
  /** Shown beside a disabled button so it never looks broken. */
  disabledHint?: string
  bottom: number
  onPress: () => void
}) {
  useMobileColorScheme()
  const reducedMotion = useReducedMotionEnabled() === true
  const shown = useSharedValue(props.visible ? 1 : 0)
  const [pressed, setPressed] = useState(false)

  // Stays mounted while hidden, so a quick flip back to the tab reverses the fade mid-way.
  useEffect(() => {
    shown.value = withTiming(props.visible ? 1 : 0, {
      duration: reducedMotion ? 0 : props.visible ? 220 : 140,
      easing: HOME_EASE_OUT
    })
  }, [props.visible, reducedMotion, shown])

  const style = useAnimatedStyle(
    () => ({
      opacity: shown.value * (props.disabled ? 0.4 : 1),
      transform: [{ scale: reducedMotion ? 1 : 0.9 + shown.value * 0.1 }]
    }),
    [shown, props.disabled, reducedMotion]
  )

  return (
    <View
      style={[styles.anchor, { bottom: props.bottom }]}
      pointerEvents={props.visible ? 'box-none' : 'none'}
    >
      {props.visible && props.disabled && props.disabledHint ? (
        <Text style={styles.hint} numberOfLines={2}>
          {props.disabledHint}
        </Text>
      ) : null}
      <Animated.View style={style}>
        <Pressable
          accessibilityRole="button"
          accessibilityElementsHidden={!props.visible}
          importantForAccessibility={props.visible ? 'auto' : 'no-hide-descendants'}
          accessibilityLabel={props.accessibilityLabel}
          accessibilityState={{ disabled: props.disabled }}
          disabled={props.disabled}
          onPressIn={() => setPressed(true)}
          onPressOut={() => setPressed(false)}
          onPress={props.onPress}
          hitSlop={6}
        >
          <Animated.View
            style={[
              styles.button,
              props.disabled && styles.buttonFlat,
              {
                transform: [{ scale: pressed ? 0.92 : 1 }],
                transitionProperty: 'transform',
                transitionDuration: pressed ? 90 : 180,
                transitionTimingFunction: 'ease-out'
              }
            ]}
          >
            <Plus size={26} strokeWidth={2.4} color={colors.onAccent} />
          </Animated.View>
        </Pressable>
      </Animated.View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  anchor: {
    position: 'absolute',
    right: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md
  },
  button: {
    width: SIZE,
    height: SIZE,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentBlue,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 6
  },
  buttonFlat: { shadowOpacity: 0, elevation: 0 },
  hint: {
    maxWidth: 220,
    fontSize: 13,
    color: colors.textSecondary,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radii.pill,
    overflow: 'hidden'
  }
}))
