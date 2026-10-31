import { Pressable } from 'react-native'
import { Maximize2, Minimize2 } from 'lucide-react-native'
import { colors } from '../../../theme/mobile-theme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { composerInputStyles as inputStyles } from '../../../components/composer-input/composer-input-styles'
import type { ChatWidthToggle } from './use-chat-bottom-fit'

/** Runs the chat across the iPhone Duo's status column, or keeps it clear of what the column draws. */
export function MobileNativeChatWidthToggle({
  expanded,
  onToggle
}: ChatWidthToggle): React.JSX.Element {
  const t = useMobileTranslation()
  const Icon = expanded ? Minimize2 : Maximize2
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        expanded
          ? t('chat.composer.keepChatClear', 'Keep chat clear of the side column')
          : t('chat.composer.expandChat', 'Expand chat into the side column')
      }
      accessibilityState={{ expanded }}
      style={({ pressed }) => [inputStyles.ghostButton, pressed && inputStyles.pressed]}
      onPress={onToggle}
      hitSlop={6}
    >
      <Icon size={18} color={colors.textSecondary} strokeWidth={2} />
    </Pressable>
  )
}
