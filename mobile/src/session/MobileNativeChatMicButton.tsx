import { Pressable, type StyleProp, type ViewStyle } from 'react-native'
import { Mic, Square } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { keepHeldPressThroughLongPress } from './held-press-long-press'
import type { MobileDictationPhase } from './native-chat-dictation-toggle'

type Props = {
  dictationPhase: MobileDictationPhase
  /** Dictation trigger style — 'hold' uses press-in/out, 'toggle' uses tap. */
  dictationMode: string
  onMicPress: () => void
  onMicPressIn?: () => void
  onMicPressOut?: () => void
  disabled: boolean
  buttonStyle: StyleProp<ViewStyle>
  pressedStyle: StyleProp<ViewStyle>
}

function micLabel(phase: MobileDictationPhase): string {
  switch (phase) {
    case 'recording':
      return 'Stop dictation'
    case 'salvaging':
      return 'Finishing dictation'
    default:
      return 'Dictate'
  }
}

export function MobileNativeChatMicButton({
  dictationPhase,
  dictationMode,
  onMicPress,
  onMicPressIn,
  onMicPressOut,
  disabled,
  buttonStyle,
  pressedStyle
}: Props): React.JSX.Element {
  const hold = dictationMode === 'hold'
  // Why: a failed stream finishing within its grace keeps its text, so no press may cancel it.
  const salvaging = dictationPhase === 'salvaging'
  return (
    <Pressable
      accessibilityLabel={micLabel(dictationPhase)}
      style={({ pressed }) => [buttonStyle, pressed && pressedStyle]}
      // Hold mode is walkie-talkie (press-in/out); toggle mode taps.
      onPress={hold ? undefined : onMicPress}
      onPressIn={hold ? onMicPressIn : undefined}
      onPressOut={hold ? onMicPressOut : undefined}
      onLongPress={hold ? keepHeldPressThroughLongPress : undefined}
      disabled={disabled || salvaging}
    >
      {/* The icon swaps on press; as the page's touch target, its removal would send
          touchend to a detached node and lose the release. */}
      {dictationPhase === 'recording' ? (
        <Square
          pointerEvents="none"
          size={18}
          color={colors.statusRed}
          strokeWidth={2.4}
          fill={colors.statusRed}
        />
      ) : (
        <Mic pointerEvents="none" size={20} color={colors.textSecondary} strokeWidth={2} />
      )}
    </Pressable>
  )
}
