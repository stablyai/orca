import { ActivityIndicator, Pressable, type StyleProp, type ViewStyle } from 'react-native'
import { ImagePlus, Mic } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { keepHeldPressThroughLongPress } from './held-press-long-press'

type DictationState = {
  readonly isStarting: boolean
  readonly isRecording: boolean
  readonly isProcessing: boolean
}

type MobileTerminalInputActionsProps = {
  readonly canSend: boolean
  readonly isAttaching: boolean
  readonly dictation: DictationState
  readonly dictationMode: string | undefined
  readonly dictationEnabled?: boolean
  readonly buttonStyle: StyleProp<ViewStyle>
  readonly activeButtonStyle: StyleProp<ViewStyle>
  readonly disabledButtonStyle: StyleProp<ViewStyle>
  readonly onAttachImage: () => void
  readonly onAttachFile: () => void
  readonly onDictationToggle: () => void
  readonly onDictationPressIn: () => void
  readonly onDictationPressOut: () => void
  readonly onDictationCancel: () => void
}

export function MobileTerminalInputActions({
  canSend,
  isAttaching,
  dictation,
  dictationMode,
  dictationEnabled = true,
  buttonStyle,
  activeButtonStyle,
  disabledButtonStyle,
  onAttachImage,
  onAttachFile,
  onDictationToggle,
  onDictationPressIn,
  onDictationPressOut,
  onDictationCancel
}: MobileTerminalInputActionsProps) {
  useMobileColorScheme()
  const dictationActive = dictation.isStarting || dictation.isRecording
  return (
    <>
      <Pressable
        style={[buttonStyle, (!canSend || isAttaching) && disabledButtonStyle]}
        disabled={!canSend || isAttaching}
        // Upload through host RPC so remote/SSH terminals attach images the same way as local terminals.
        onPress={onAttachImage}
        onLongPress={onAttachFile}
        delayLongPress={350}
        accessibilityLabel={isAttaching ? 'Sending image' : 'Attach a photo'}
        accessibilityHint="Long press to attach a file instead"
      >
        {isAttaching ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : (
          <ImagePlus size={17} color={colors.textSecondary} strokeWidth={2.4} />
        )}
      </Pressable>
      {dictationEnabled ? (
        <Pressable
          style={[
            buttonStyle,
            dictationActive && activeButtonStyle,
            !canSend && disabledButtonStyle
          ]}
          disabled={!canSend}
          onPress={dictationMode === 'toggle' ? onDictationToggle : undefined}
          onPressIn={dictationMode === 'hold' ? onDictationPressIn : undefined}
          onPressOut={dictationMode === 'hold' ? onDictationPressOut : undefined}
          onLongPress={
            dictationMode === 'toggle'
              ? () => {
                  if (dictation.isRecording || dictation.isProcessing) {
                    onDictationCancel()
                  }
                }
              : keepHeldPressThroughLongPress
          }
          accessibilityLabel={
            dictation.isRecording
              ? 'Stop voice dictation'
              : dictation.isProcessing
                ? 'Transcribing voice dictation'
                : dictation.isStarting
                  ? 'Starting voice dictation'
                  : 'Start voice dictation'
          }
        >
          {dictation.isProcessing ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <Mic
              size={17}
              color={dictationActive ? colors.textPrimary : colors.textSecondary}
              strokeWidth={2.4}
            />
          )}
        </Pressable>
      ) : null}
    </>
  )
}
