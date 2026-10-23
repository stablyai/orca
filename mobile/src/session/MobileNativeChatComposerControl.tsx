import type { ReactNode } from 'react'
import { Pressable, StyleSheet, View, type PressableProps } from 'react-native'
import { colors, MIN_TOUCH_TARGET, motion } from '../theme/mobile-theme'
import { pressTransition } from '../components/ui/transition-styles'
import { COMPOSER_CONTROL_SIZE } from './mobile-native-chat-composer-styles'

/** `primary` is the one white Send; `idle` is Send with nothing to send; `alert` is a live mic. */
export type ComposerControlTone = 'filled' | 'primary' | 'idle' | 'alert'

const FILL: Record<ComposerControlTone, { rest: string; pressed: string }> = {
  filled: { rest: colors.fill, pressed: colors.fillPressed },
  primary: { rest: colors.primary, pressed: colors.primaryPressed },
  idle: { rest: colors.fill, pressed: colors.fill },
  // No token for a tinted danger fill; the Banner's error fill, a step stronger.
  alert: { rest: 'rgba(255, 107, 107, 0.16)', pressed: 'rgba(255, 107, 107, 0.26)' }
}

type Props = Omit<PressableProps, 'style' | 'children'> & {
  tone?: ComposerControlTone
  children: ReactNode
}

/** One of the composer's round controls: a 44 pt touch box around a 36 pt filled circle. */
export function MobileNativeChatComposerControl({
  tone = 'filled',
  children,
  ...pressable
}: Props): React.JSX.Element {
  return (
    <Pressable accessibilityRole="button" {...pressable} style={styles.touch}>
      {({ pressed }) => {
        const active = pressed && tone !== 'idle' && !pressable.disabled
        return (
          <View
            pointerEvents="none"
            style={[
              styles.circle,
              { backgroundColor: active ? FILL[tone].pressed : FILL[tone].rest },
              active && styles.pressed,
              active ? pressTransition.pressed : pressTransition.rest
            ]}
          >
            {children}
          </View>
        )
      }}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  touch: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center'
  },
  circle: {
    width: COMPOSER_CONTROL_SIZE,
    height: COMPOSER_CONTROL_SIZE,
    borderRadius: COMPOSER_CONTROL_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center'
  },
  pressed: { transform: [{ scale: motion.pressedIconScale }] }
})
