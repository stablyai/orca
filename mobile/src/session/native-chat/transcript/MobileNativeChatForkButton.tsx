import { useContext } from 'react'
import { Pressable } from 'react-native'
import { GitBranch } from 'lucide-react-native'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { colors, radii } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { MobileNativeChatForkContext } from '../use-mobile-native-chat-fork'

/** Beside a response's copy button; its own consumer, so fork state never re-renders the row. */
export function MobileNativeChatForkButton({
  message
}: {
  message: NativeChatMessage
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const fork = useContext(MobileNativeChatForkContext)
  const offer = fork?.offerFor(message) ?? 'hidden'
  if (!fork || offer === 'hidden') {
    return null
  }
  // Disabled while the host is still asked, or while a fork from this chat opens.
  const disabled = offer === 'disabled'
  return (
    <Pressable
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={t('chat.message.forkFromResponse', 'Fork from this response')}
      accessibilityHint={t(
        'chat.message.forkFromResponseHint',
        'A new chat with this whole response, up to the end of its turn'
      )}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => fork.fork(message)}
    >
      <GitBranch size={14} color={colors.textMuted} style={disabled ? styles.disabled : null} />
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  button: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control
  },
  pressed: { backgroundColor: colors.bgRaised },
  disabled: { opacity: 0.4 }
}))
