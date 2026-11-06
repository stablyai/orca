import { Animated, Text } from 'react-native'
import { styles } from './mobile-session-styles'

export function MobileSessionToast({
  message,
  animatedStyle
}: {
  message: string | null
  animatedStyle: React.ComponentProps<typeof Animated.View>['style']
}): React.JSX.Element | null {
  if (!message) {
    return null
  }
  return (
    <Animated.View pointerEvents="none" style={[styles.toast, animatedStyle]}>
      <Text style={styles.toastText}>{message}</Text>
    </Animated.View>
  )
}
