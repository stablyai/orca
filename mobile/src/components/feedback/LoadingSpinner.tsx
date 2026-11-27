import { Animated } from 'react-native'
import { Hourglass, LoaderCircle } from '../icons/icon-set'
import { useReducedMotionEnabled } from '../../platform/accessibility/use-reduced-motion'
import { useWorkingRingRotation } from '../motion/use-working-motion'

// Match desktop one-second spinner; reduced motion uses distinct working icon so frozen circle does not look stuck.
export function LoadingSpinner({
  size,
  color
}: {
  size: number
  color: string
}): React.JSX.Element {
  const reducedMotion = useReducedMotionEnabled()
  const ring = useWorkingRingRotation(reducedMotion === false)
  if (reducedMotion) {
    return <Hourglass size={size} color={color} />
  }
  return (
    <Animated.View ref={ring.ref} style={ring.style}>
      <LoaderCircle size={size} color={color} />
    </Animated.View>
  )
}
