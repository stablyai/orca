import { Animated } from 'react-native'
import { Hourglass, LoaderCircle } from 'lucide-react-native'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { useWorkingRingRotation } from './use-working-ring-rotation'

/** Desktop's LoadingSpinner: the same turning circle, once per second.
 *  Why: a spinner frozen by reduced motion reads as stuck, so the still state is
 *  a different icon that says "working" without moving. */
export function LoadingSpinner({
  size,
  color
}: {
  size: number
  color: string
}): React.JSX.Element {
  const reducedMotion = useReducedMotionEnabled()
  const rotate = useWorkingRingRotation(reducedMotion === false)
  if (reducedMotion) {
    return <Hourglass size={size} color={color} strokeWidth={2} />
  }
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <LoaderCircle size={size} color={color} strokeWidth={2} />
    </Animated.View>
  )
}
