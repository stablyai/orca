import { Pressable, View } from 'react-native'
import { ArrowDown } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { styles } from './mobile-native-chat-view-styles'

export function MobileNativeChatFloatingControls({
  showJumpToTail,
  onJumpToTail
}: {
  showJumpToTail: boolean
  onJumpToTail: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  return (
    <View pointerEvents="box-none" style={styles.floatingControls}>
      {showJumpToTail ? (
        <Pressable accessibilityLabel="Scroll to latest" style={styles.fab} onPress={onJumpToTail}>
          <ArrowDown size={18} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
      ) : null}
    </View>
  )
}
