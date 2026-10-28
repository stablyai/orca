import { ActivityIndicator, Pressable } from 'react-native'
import { Mic, Square } from 'lucide-react-native'
import { colors } from '../../../theme/mobile-theme'
import { keepHeldPressThroughLongPress } from '../../held-press-long-press'
import { mobileNativeChatComposerStyles as styles } from './mobile-native-chat-composer-styles'

export type MobileNativeChatMicProps = {
  onMicPress?: () => void
  micActive?: boolean
  /** Transcribing after stop; taps are ignored until the transcript lands. */
  micProcessing?: boolean
  dictationMode?: string
  onMicPressIn?: () => void
  onMicPressOut?: () => void
}

export function MobileNativeChatComposerMic({
  onMicPress,
  micActive = false,
  micProcessing = false,
  dictationMode = 'toggle',
  onMicPressIn,
  onMicPressOut,
  disabled
}: MobileNativeChatMicProps & { disabled: boolean }): React.JSX.Element {
  return (
    <Pressable
      accessibilityLabel={
        micActive ? 'Stop dictation' : micProcessing ? 'Transcribing dictation' : 'Dictate'
      }
      style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]}
      // Hold mode is walkie-talkie (press-in/out); toggle mode taps.
      onPress={dictationMode === 'hold' ? undefined : onMicPress}
      onPressIn={dictationMode === 'hold' ? onMicPressIn : undefined}
      onPressOut={dictationMode === 'hold' ? onMicPressOut : undefined}
      onLongPress={dictationMode === 'hold' ? keepHeldPressThroughLongPress : undefined}
      disabled={disabled && !micActive}
    >
      {/* The icon swaps on press; as the page's touch target, its removal would send
          touchend to a detached node and lose the release. */}
      {micProcessing ? (
        <ActivityIndicator pointerEvents="none" size="small" color={colors.textSecondary} />
      ) : micActive ? (
        <Square
          pointerEvents="none"
          size={16}
          color={colors.statusRed}
          strokeWidth={2.4}
          fill={colors.statusRed}
        />
      ) : (
        <Mic pointerEvents="none" size={19} color={colors.textSecondary} strokeWidth={2} />
      )}
    </Pressable>
  )
}
