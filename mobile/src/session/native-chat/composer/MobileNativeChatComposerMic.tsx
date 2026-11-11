import { Pressable, type View } from 'react-native'
import { useContext, type RefObject } from 'react'
import { MobileDictationLiveContext } from '../../../dictation/mobile-dictation-live-context'
import { dictationControlsCopy } from '../../../dictation/mobile-dictation-controls-copy'
import {
  MobileDictationMicIcon,
  MobileDictationRetryButton
} from '../../../dictation/MobileDictationLiveControls'
import { useMobileDictationCancelDrop } from '../../../dictation/use-mobile-dictation-cancel-drop'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { keepHeldPressThroughLongPress } from '../../../platform/held-press-long-press'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStyles as inputStyles
} from '../../../components/composer-input/composer-input-styles'
import { MobileNativeChatControlSwap } from '../input/mobile-native-chat-control-swap'

export type MobileNativeChatMicProps = {
  onMicPress?: () => void
  /** Starting or recording: the mic is live and its release must reach the hook. */
  micActive?: boolean
  /** Waiting on the host; speech is already held, and a tap stops once recording begins. */
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
  cancelRef,
  disabled
}: MobileNativeChatMicProps & {
  disabled: boolean
  // The composer's ✕ that a held mic may be released over.
  cancelRef?: RefObject<View | null>
}): React.JSX.Element {
  useMobileTranslation()
  const live = useContext(MobileDictationLiveContext)
  const release = useMobileDictationCancelDrop(cancelRef, live?.cancel, onMicPressOut)
  if (live?.failureReason != null) {
    return <MobileDictationRetryButton onRetry={live.retry} labelled />
  }
  return (
    <Pressable
      accessibilityRole="button"
      aria-busy={micStarting || micProcessing}
      accessibilityLabel={dictationControlsCopy.mic({
        starting: micStarting,
        active: micActive,
        processing: micProcessing
      })}
      style={({ pressed }) => [inputStyles.ghostButton, pressed && inputStyles.pressed]}
      // Hold mode is walkie-talkie (press-in/out); toggle mode taps.
      onPress={dictationMode === 'hold' ? undefined : onMicPress}
      onPressIn={dictationMode === 'hold' ? onMicPressIn : undefined}
      onPressOut={dictationMode === 'hold' ? release : undefined}
      onLongPress={dictationMode === 'hold' ? keepHeldPressThroughLongPress : undefined}
      disabled={disabled && !micActive}
      hitSlop={COMPOSER_CONTROL_HIT_SLOP}
    >
      {/* The icon swaps on press; as the page's touch target, its removal would send
            touchend to a detached node and lose the release. */}
      <MobileNativeChatControlSwap
        swapKey={micProcessing ? 'processing' : micActive ? 'active' : 'idle'}
        icon
      >
        <MobileDictationMicIcon
          active={micActive}
          processing={micProcessing}
          micSize={19}
          micStroke={2}
        />
      </MobileNativeChatControlSwap>
    </Pressable>
  )
}
