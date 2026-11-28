// The page's react-native-gesture-handler imports: the package has no sideEffects field, so its
// root barrel keeps legacy touchables, buttons, components, handlers, and unused v3 hooks.
import { initialize } from 'react-native-gesture-handler/lib/module/init'

initialize()

export { default as GestureHandlerRootView } from 'react-native-gesture-handler/lib/module/components/GestureHandlerRootView'
export { GestureObjects as Gesture } from 'react-native-gesture-handler/lib/module/handlers/gestures/gestureObjects'
export { GestureDetector } from 'react-native-gesture-handler/lib/module/v3/detectors/GestureDetector'
