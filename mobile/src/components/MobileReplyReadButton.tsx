import { Pressable } from 'react-native'
import { Volume2 } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useReplySpeech } from '../platform/reply-speech'
import { colors, radii } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

// Why: no Stop here; the reader overlay's Stop pill ends the reading on any screen.
export function MobileReplyReadButton({
  id,
  text,
  disabled = false
}: {
  id: string
  text: string
  disabled?: boolean
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const speech = useReplySpeech()
  if (!speech.canSpeak || text.length === 0) {
    return null
  }
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        disabled && styles.disabled,
        pressed && styles.pressed
      ]}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={t('components.mobileReplyReadButton.readReply', 'Read reply aloud')}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => speech.speak(id, text)}
    >
      <Volume2 size={14} color={colors.textMuted} />
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  button: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
  },
  disabled: { opacity: 0.4 },
  pressed: { backgroundColor: colors.bgRaised }
}))
