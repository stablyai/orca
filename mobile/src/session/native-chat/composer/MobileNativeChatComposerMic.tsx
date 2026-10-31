import { ActivityIndicator, Pressable, View } from 'react-native'
import { Mic, Square } from 'lucide-react-native'
import { useContext } from 'react'
import { colors } from '../../../theme/mobile-theme'
import { MobileDictationGrapes, MobileDictationTimer } from '../../MobileDictationMeter'
import { MobileDictationMeterContext } from '../../mobile-dictation-meter-context'
import { keepHeldPressThroughLongPress } from '../../held-press-long-press'
import { composerInputStyles as inputStyles } from '../../../components/composer-input/composer-input-styles'
import { mobileNativeChatComposerStyles as styles } from './mobile-native-chat-composer-styles'

export type MobileNativeChatMicProps = {
  onMicPress?: () => void
  /** Starting or recording: the mic is live and its release must reach the hook. */
  micActive?: boolean
  /** Still opening the mic; taps are ignored until recording begins. */
  micStarting?: boolean
  /** Transcribing after stop; taps are ignored until the transcript lands. */
  micProcessing?: boolean
  dictationMode?: string
  onMicPressIn?: () => void
  onMicPressOut?: () => void
}

export function MobileNativeChatComposerMic({
  onMicPress,
  micActive = false,
  micStarting = false,
  micProcessing = false,
  dictationMode = 'toggle',
  onMicPressIn,
  onMicPressOut,
  disabled
}: MobileNativeChatMicProps & { disabled: boolean }): React.JSX.Element {
  const meter = useContext(MobileDictationMeterContext)
  const recordingMeter = micActive && !micStarting ? meter : null
  // Keep the mic at the same fragment slot: remounting it mid-hold would lose the release.
  return (
    <>
      {recordingMeter ? (
        <View style={styles.dictationMeter}>
          <MobileDictationGrapes meter={recordingMeter} dotSize={5} />
          <MobileDictationTimer meter={recordingMeter} />
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        aria-busy={micStarting || micProcessing}
        accessibilityLabel={
          micStarting
            ? 'Starting dictation'
            : micActive
              ? 'Stop dictation'
              : micProcessing
                ? 'Transcribing dictation'
                : 'Dictate'
        }
        style={({ pressed }) => [inputStyles.ghostButton, pressed && inputStyles.pressed]}
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
    </>
  )
}
