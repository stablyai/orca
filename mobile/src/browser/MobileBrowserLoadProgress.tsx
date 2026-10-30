import { useEffect, useRef } from 'react'
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { colors, radii } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

// Match desktop progress: delay fast loads, ease toward 90%, finish on real stop.
const SHOW_DELAY_MS = 200
const TRICKLE_STEPS: [atMs: number, scale: number][] = [
  [300, 0.15],
  [2_000, 0.45],
  [6_000, 0.7],
  [15_000, 0.85],
  [30_000, 0.9]
]
// Why: web has no native driver.
const useNativeDriver = Platform.OS !== 'web'

function timing(value: Animated.Value, toValue: number, duration: number) {
  return Animated.timing(value, {
    toValue,
    duration,
    easing: Easing.out(Easing.quad),
    isInteraction: false,
    useNativeDriver
  })
}

/** A thin line along the bottom edge of the address field while the desktop page loads. */
export function MobileBrowserLoadProgress({
  loading,
  failed
}: {
  loading: boolean
  failed: boolean
}): React.JSX.Element {
  useMobileColorScheme()
  const scale = useRef(new Animated.Value(0)).current
  const opacity = useRef(new Animated.Value(0)).current
  const runningRef = useRef<{
    animation: Animated.CompositeAnimation
    loading: boolean
    reducedMotion: boolean
  } | null>(null)
  // Why: native stopAnimation answers asynchronously, so a newer load or unmount voids its callback.
  const generationRef = useRef(0)
  // Unknown counts as reduced, the same as LoadingSpinner.
  const reducedMotion = useReducedMotionEnabled() !== false

  useEffect(() => {
    const running = runningRef.current
    if (loading) {
      // Why: a navigation that replaces one in flight keeps loading true, so the line carries on.
      if (running?.loading && running.reducedMotion === reducedMotion) {
        return
      }
      generationRef.current += 1
      running?.animation.stop()
      scale.setValue(reducedMotion ? 1 : 0)
      opacity.setValue(0)
      let previousMs = 0
      const trickle = TRICKLE_STEPS.map(([atMs, toScale]) => {
        const step = timing(scale, toScale, atMs - previousMs)
        previousMs = atMs
        return step
      })
      const animation = Animated.sequence([
        // A motion-preference switch mid-load swaps the animation without hiding it again.
        Animated.delay(running?.loading ? 0 : SHOW_DELAY_MS),
        reducedMotion
          ? timing(opacity, 0.5, 150)
          : Animated.parallel([timing(opacity, 1, 150), Animated.sequence(trickle)])
      ])
      runningRef.current = { animation, loading: true, reducedMotion }
      animation.start()
      return
    }
    if (!running?.loading) {
      return
    }
    running.animation.stop()
    runningRef.current = null
    const generation = ++generationRef.current
    opacity.stopAnimation((shownOpacity) => {
      if (generation !== generationRef.current) {
        return
      }
      // Still inside the show delay: the load was fast enough to show nothing.
      if (shownOpacity === 0) {
        scale.setValue(0)
        return
      }
      // Why: a failed load fades where it stopped instead of filling up like a success.
      const fadeOut = timing(opacity, 0, 270)
      const animation =
        failed || reducedMotion ? fadeOut : Animated.sequence([timing(scale, 1, 180), fadeOut])
      runningRef.current = { animation, loading: false, reducedMotion }
      animation.start()
    })
  }, [failed, loading, opacity, reducedMotion, scale])

  useEffect(
    () => () => {
      generationRef.current += 1
      runningRef.current?.animation.stop()
    },
    []
  )

  return (
    <View pointerEvents="none" style={styles.clip}>
      <Animated.View
        testID="mobile-browser-load-progress"
        style={[styles.line, { opacity, transform: [{ scaleX: scale }] }]}
      />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  clip: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: radii.control,
    overflow: 'hidden'
  },
  line: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    backgroundColor: colors.accentBlue,
    transformOrigin: 'left'
  }
}))
