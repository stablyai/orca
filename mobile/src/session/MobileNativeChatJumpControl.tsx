import { Pressable } from 'react-native'
import { ArrowDown, CornerLeftUp } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-view-styles'

/** The list's one floating control. Reading history, it returns to the latest
 *  message; at the bottom of a reply taller than the screen, it goes up to the
 *  prompt. The two never show together, so they share a slot. */
export function MobileNativeChatJumpControl({
  atBottom,
  showPromptJump,
  onScrollToLatest,
  onJumpToPrompt
}: {
  atBottom: boolean
  showPromptJump: boolean
  onScrollToLatest: () => void
  onJumpToPrompt: () => void
}): React.JSX.Element | null {
  if (!atBottom) {
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
