import { Animated, Easing, Platform } from 'react-native'

// Why: react-native-web ships no native animated module, yet `Animated.loop` still branches on
// the raw `useNativeDriver` flag rather than on driver availability. With `true` it takes the
// `_startNativeLoop` path, which on web starts a single JS-driven timing pass with a config the
// JS driver ignores `iterations` from — the value ramps 0 -> 1 once and then stops forever, so
// every looping spinner freezes in the hybrid WebView. Only claim the driver where it exists.
export const nativeAnimatedDriverSupported = Platform.OS !== 'web'

const SPIN_DURATION_MS = 1000

/** Continuous 0 -> 1 rotation driver shared by the worktree and per-agent busy spinners. */
export function createRotationLoop(
  value: Animated.Value,
  durationMs: number = SPIN_DURATION_MS
): Animated.CompositeAnimation {
  return Animated.loop(
    Animated.timing(value, {
      toValue: 1,
      duration: durationMs,
      easing: Easing.linear,
      useNativeDriver: nativeAnimatedDriverSupported
    })
  )
}
