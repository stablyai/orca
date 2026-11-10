import type { Animated } from 'react-native'

// RN 0.88 names these through an unexported module, so declaration emit cannot name them in
// inferred hook results. Exported intersection aliases keep nameable types.
export type MobileAnimatedValue = Animated.Value & { readonly mobileAnimatedValue?: never }
export type MobileAnimatedInterpolation = Animated.AnimatedInterpolation<number> & {
  readonly mobileAnimatedInterpolation?: never
}
