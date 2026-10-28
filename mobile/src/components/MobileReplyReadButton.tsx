import { Pressable } from 'react-native'
import { Volume2 } from 'lucide-react-native'
import { useReplySpeech } from '../platform/reply-speech'
import { colors, radii } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

// Why: no Stop here; the reader overlay's Stop pill ends the reading on any screen.
export function MobileReplyReadButton({
  id,
  text
}: {
  id: string
  text: string
}): React.JSX.Element | null {
  useMobileColorScheme()
  const speech = useReplySpeech()
  if (!speech.canSpeak || text.length === 0) {
    return null
  }
  return (
    <Pressable
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel="Read reply aloud"
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
  pressed: { backgroundColor: colors.bgRaised }
}))
