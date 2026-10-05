import { Pressable } from 'react-native'
import { ArrowDown, CornerLeftUp } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-view-styles'

/** Prompt and latest-message navigation share one floating slot. */
export function MobileNativeChatJumpControl({
  showJumpToTail,
  showPromptJump,
  onScrollToLatest,
  onJumpToPrompt
}: {
  showJumpToTail: boolean
  showPromptJump: boolean
  onScrollToLatest: () => void
  onJumpToPrompt: () => void
}): React.JSX.Element | null {
  if (showJumpToTail) {
    return (
      <Pressable
        accessibilityLabel="Scroll to latest"
        style={[styles.fab, styles.fabBottom]}
        onPress={onScrollToLatest}
      >
        <ArrowDown size={18} color={colors.textPrimary} strokeWidth={2.2} />
      </Pressable>
    )
  }
  if (!showPromptJump) {
    return null
  }
  return (
    <Pressable
      accessibilityLabel="Scroll to prompt"
      style={[styles.fab, styles.fabBottom]}
      onPress={onJumpToPrompt}
    >
      <CornerLeftUp size={18} color={colors.textPrimary} strokeWidth={2.2} />
    </Pressable>
  )
}
