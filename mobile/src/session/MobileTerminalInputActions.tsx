import { ActivityIndicator, Pressable, View, type StyleProp, type ViewStyle } from 'react-native'
import { ImagePlus, Mic } from 'lucide-react-native'
import type { MobileDictationMeter } from '../hooks/mobile-dictation-meter'
import { colors } from '../theme/mobile-theme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { keepHeldPressThroughLongPress } from './held-press-long-press'
import { MobileDictationHalo } from './MobileDictationMeter'

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
  /** Shows the voice level as a halo behind the mic where no status row carries the meter. */
  readonly meterHalo?: MobileDictationMeter
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
  meterHalo,
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
  const t = useMobileTranslation()
  const dictationActive = dictation.isStarting || dictation.isRecording
  // Dictation outlives a reconnect, so its stop and cancel must too; only starting needs the connection.
  const micDisabled = !canSend && !dictationActive && !dictation.isProcessing
  const mic = (
    <Pressable
      style={[
        buttonStyle,
        dictationActive && activeButtonStyle,
        micDisabled && disabledButtonStyle
      ]}
      disabled={micDisabled}
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
      accessibilityRole="button"
      aria-busy={dictation.isStarting || dictation.isProcessing}
      accessibilityLabel={
        dictation.isRecording
          ? t('session.terminalInputActions.stopDictation', 'Stop voice dictation')
          : dictation.isProcessing
            ? t(
                'session.terminalInputActions.transcribingDictation',
                'Transcribing voice dictation'
              )
            : dictation.isStarting
              ? t('session.terminalInputActions.startingDictation', 'Starting voice dictation')
              : t('session.terminalInputActions.startDictation', 'Start voice dictation')
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
  )
  return (
    <>
      <Pressable
        style={[buttonStyle, (!canSend || isAttaching) && disabledButtonStyle]}
        disabled={!canSend || isAttaching}
        // Upload through host RPC so remote/SSH terminals attach images the same way as local terminals.
        onPress={onAttachImage}
        onLongPress={onAttachFile}
        delayLongPress={350}
        accessibilityLabel={
          isAttaching
            ? t('session.terminalInputActions.sendingImage', 'Sending image')
            : t('session.terminalInputActions.attachPhoto', 'Attach a photo')
        }
        accessibilityHint={t(
          'session.terminalInputActions.attachFileHint',
          'Long press to attach a file instead'
        )}
      >
        {isAttaching ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : (
          <ImagePlus size={17} color={colors.textSecondary} strokeWidth={2.4} />
        )}
      </Pressable>
      {dictationEnabled ? (
        meterHalo ? (
          // Always wrapped, so the mic never remounts under a held press.
          <View>
            {dictation.isRecording ? <MobileDictationHalo meter={meterHalo} size={34} /> : null}
            {mic}
          </View>
        ) : (
          mic
        )
      ) : null}
    </>
  )
}
