// The page's react-native-reanimated imports: the package root marks itself side-effectful and
// re-exports 40+ unused layout animation presets, CSS animations, Colors, and jestUtils.
import 'react-native-reanimated/lib/module/publicGlobals'
import { initializeReanimatedModule } from 'react-native-reanimated/lib/module/initializers'
import { ReanimatedModule } from 'react-native-reanimated/lib/module/ReanimatedModule'
import * as Animated from 'react-native-reanimated/lib/module/Animated'

initializeReanimatedModule(ReanimatedModule)

export default Animated
export {
  cancelAnimation,
  withSpring,
  withTiming
} from 'react-native-reanimated/lib/module/animation/index'
export { ReduceMotion } from 'react-native-reanimated/lib/module/commonTypes'
export { NativeEventsManager } from 'react-native-reanimated/lib/module/createAnimatedComponent/index'
export { Easing } from 'react-native-reanimated/lib/module/Easing'
export {
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useEvent,
  useFrameCallback,
  useReducedMotion,
  useSharedValue
} from 'react-native-reanimated/lib/module/hook/index'
export { interpolateColor } from 'react-native-reanimated/lib/module/interpolateColor'
export { interpolate } from 'react-native-reanimated/lib/module/interpolation'
export { isSharedValue } from 'react-native-reanimated/lib/module/isSharedValue'
export {
  measure,
  scrollTo,
  setGestureState
} from 'react-native-reanimated/lib/module/platformFunctions/index'
export { runOnJS, runOnUI } from 'react-native-reanimated/lib/module/workletFunctions'
