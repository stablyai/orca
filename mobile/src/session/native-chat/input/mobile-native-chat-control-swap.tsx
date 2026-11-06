import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native'
import { SHEET_CURVE } from '../../../components/sheet-motion-values'
import { useReducedMotionEnabled } from '../../../platform/use-reduced-motion'

const SWAP_MS = 150
const REDUCED_SWAP_MS = 100
const SWAP_EASING = Easing.bezier(...SHEET_CURVE)
const SWAP_FROM_SCALE = 0.6

type SwapLayer = { key: string; node: ReactNode }

/**
 * Eases a composer control in when what it does changes (Send, Stop, the mic's states).
 * `icon` swaps sit inside a live Pressable: both layers ignore touches and the old icon fades
 * out on top, so the press never moves off the control mid-hold.
 */
export function MobileNativeChatControlSwap({
  swapKey,
  icon = false,
  children
}: {
  swapKey: string
  icon?: boolean
  children: ReactNode
}): React.JSX.Element {
  const reducedMotion = useReducedMotionEnabled() === true
  const shown = useRef<SwapLayer>({ key: swapKey, node: children })
  const [leaving, setLeaving] = useState<SwapLayer | null>(null)
  const progress = useRef(new Animated.Value(1)).current

  // Before paint, so the new control never shows a frame at rest before it eases in.
  useLayoutEffect(() => {
    const previous = shown.current
    shown.current = { key: swapKey, node: children }
    if (previous.key === swapKey) {
      return
    }
    setLeaving(icon ? previous : null)
    progress.setValue(0)
    Animated.timing(progress, {
      toValue: 1,
      duration: reducedMotion ? REDUCED_SWAP_MS : SWAP_MS,
      easing: SWAP_EASING,
      useNativeDriver: Platform.OS !== 'web'
    }).start(({ finished }) => {
      if (finished) {
        setLeaving(null)
      }
    })
  })
  useEffect(() => () => progress.stopAnimation(), [progress])

  const scale = (from: number, to: number) =>
    reducedMotion ? 1 : progress.interpolate({ inputRange: [0, 1], outputRange: [from, to] })
  const touches = icon ? 'none' : 'box-none'
  return (
    <View pointerEvents={touches} style={styles.slot}>
      <Animated.View
        pointerEvents={touches}
        style={{ opacity: progress, transform: [{ scale: scale(SWAP_FROM_SCALE, 1) }] }}
      >
        {children}
      </Animated.View>
      {leaving ? (
        <Animated.View
          key={leaving.key}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.leaving,
            {
              opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
              transform: [{ scale: scale(1, SWAP_FROM_SCALE) }]
            }
          ]}
        >
          {leaving.node}
        </Animated.View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  slot: { alignItems: 'center', justifyContent: 'center' },
  leaving: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' }
})
