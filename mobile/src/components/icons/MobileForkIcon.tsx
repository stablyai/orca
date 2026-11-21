import { Split } from 'lucide-react-native'
import { View, type StyleProp, type ViewStyle } from 'react-native'

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
  // Lucide copies a style onto every path, where react-native-svg rotates it about (0,0) out of the viewBox.
  return (
    <View style={[ROTATED, style]}>
      <Split size={size} color={color} />
    </View>
  )
}
