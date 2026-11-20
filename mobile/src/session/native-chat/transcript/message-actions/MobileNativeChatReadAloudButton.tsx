import { useMemo } from 'react'
import { Pressable } from 'react-native'
import { Square, Volume2 } from 'lucide-react-native'
import { mobileMarkdownSpokenText } from '../../../../components/markdown/parsing/mobile-markdown-spoken-text'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { useReadAloudEngine } from '../../../../platform/read-aloud/read-aloud'
import {
  toggleReadAloud,
  useReadAloudSpeaking
} from '../../../../platform/read-aloud/read-aloud-turn'
import { colors, radii } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'

/** Reads a reply aloud with the phone's voice; tapped again, or on another reply, it stops. */
export function MobileNativeChatReadAloudButton({
  messageId,
  markdown
}: {
  messageId: string
  markdown: string
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const engine = useReadAloudEngine()
  const speaking = useReadAloudSpeaking(messageId)
  const spokenText = useMemo(() => mobileMarkdownSpokenText(markdown), [markdown])
  // A reply that is only code has nothing to speak; Stop stays while it plays.
  if (!engine.available || (!speaking && !spokenText)) {
    return null
  }
  const Icon = speaking ? Square : Volume2
  return (
    <Pressable
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={
        speaking
          ? t('chat.message.stopReadingAloud', 'Stop reading aloud')
          : t('chat.message.readAloud', 'Read aloud')
      }
      accessibilityState={{ selected: speaking }}
      onPress={() => {
        toggleReadAloud(engine, messageId, speaking ? '' : spokenText)
      }}
    >
      <Icon size={14} color={speaking ? colors.textPrimary : colors.textMuted} />
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
  pressed: { backgroundColor: colors.bgRaised }
}))
