import { Split } from 'lucide-react-native'
import type { StyleProp, ViewStyle } from 'react-native'

const ROTATED = { transform: [{ rotate: '90deg' }] }

/** Fork, as on desktop: a path splitting in two, pointing forward like the chat it branches. */
export function MobileForkIcon({
  size,
  color,
  style
}: {
  size: number
  color: string
  style?: StyleProp<ViewStyle>
}): React.JSX.Element {
  return <Split size={size} color={color} style={[ROTATED, style]} />
}
