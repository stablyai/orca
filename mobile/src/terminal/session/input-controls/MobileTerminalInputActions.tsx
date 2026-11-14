import { useContext, type RefObject } from 'react'
import {
  ActivityIndicator,
  Pressable,
  type HostInstance,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import { ImagePlus } from 'lucide-react-native'
import { colors } from '../../../theme/mobile-theme'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStyles
} from '../../../components/composer-input/composer-input-styles'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { keepHeldPressThroughLongPress } from '../../../platform/held-press-long-press'
import { dictationControlsCopy } from '../../../dictation/mobile-dictation-controls-copy'
import { useMobileDictationCancelDrop } from '../../../dictation/use-mobile-dictation-cancel-drop'
import {
  MobileDictationMicIcon,
  MobileDictationRetryButton
} from '../../../dictation/MobileDictationLiveControls'
import { MobileDictationLiveContext } from '../../../dictation/mobile-dictation-live-context'

type DictationState = {
  readonly isStarting: boolean
  readonly isRecording: boolean
  readonly isProcessing: boolean
}

type MobileTerminalDictationButtonProps = {
  readonly canSend: boolean
  readonly dictation: DictationState
  readonly dictationMode: string | undefined
  readonly dictationEnabled?: boolean
  readonly buttonStyle: StyleProp<ViewStyle>
  readonly disabledButtonStyle: StyleProp<ViewStyle>
  // The ✕ on the field that a held mic may be released over.
  readonly dictationCancelRef: RefObject<HostInstance | null>
  readonly onDictationToggle: () => void
  readonly onDictationPressIn: () => void
  readonly onDictationPressOut: () => void
  readonly onDictationCancel: () => void
}

type MobileTerminalAttachButtonProps = {
  readonly canSend: boolean
  readonly isAttaching: boolean
  readonly buttonStyle: StyleProp<ViewStyle>
  readonly disabledButtonStyle: StyleProp<ViewStyle>
  readonly onAttachImage: () => void
  readonly onAttachFile: () => void
}

type MobileTerminalInputActionsProps = MobileTerminalDictationButtonProps &
  MobileTerminalAttachButtonProps

export function MobileTerminalInputActions(props: MobileTerminalInputActionsProps) {
  const { isStarting, isRecording, isProcessing } = props.dictation
  const live = useContext(MobileDictationLiveContext)
  // A kept failure is cleared by every start and Retry, so it never shows while dictating.
  const failureReason = live?.failureReason ?? null
  // Attach steps aside while dictating or holding a failed recording, so the field gets the room.
  return (
    <>
      {isStarting || isRecording || isProcessing || failureReason !== null ? null : (
        <MobileTerminalAttachButton {...props} />
      )}
      {failureReason !== null && live ? (
        <MobileDictationRetryButton onRetry={live.retry} labelled={false} />
      ) : (
        <MobileTerminalDictationButton {...props} />
      )}
    </>
  )
}

function MobileTerminalAttachButton({
  canSend,
  isAttaching,
  buttonStyle,
  disabledButtonStyle,
  onAttachImage,
  onAttachFile
}: MobileTerminalAttachButtonProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <Pressable
      style={({ pressed }) => [
        buttonStyle,
        pressed && composerInputStyles.pressed,
        (!canSend || isAttaching) && disabledButtonStyle
      ]}
      disabled={!canSend || isAttaching}
      hitSlop={COMPOSER_CONTROL_HIT_SLOP}
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
  )
}

function MobileTerminalDictationButton({
  canSend,
  dictation,
  dictationMode,
  dictationEnabled = true,
  buttonStyle,
  disabledButtonStyle,
  dictationCancelRef,
  onDictationToggle,
  onDictationPressIn,
  onDictationPressOut,
  onDictationCancel
}: MobileTerminalDictationButtonProps) {
  useMobileColorScheme()
  useMobileTranslation()
  const release = useMobileDictationCancelDrop(
    dictationCancelRef,
    onDictationCancel,
    onDictationPressOut
  )
  if (!dictationEnabled) {
    return null
  }
  const dictationActive = dictation.isStarting || dictation.isRecording
  // Dictation outlives a reconnect, so its stop and cancel must too; only starting needs the connection.
  const micDisabled = !canSend && !dictationActive && !dictation.isProcessing
  return (
    <Pressable
      style={({ pressed }) => [
        buttonStyle,
        pressed && composerInputStyles.pressed,
        micDisabled && disabledButtonStyle
      ]}
      disabled={micDisabled}
      hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      onPress={dictationMode === 'toggle' ? onDictationToggle : undefined}
      onPressIn={dictationMode === 'hold' ? onDictationPressIn : undefined}
      onPressOut={dictationMode === 'hold' ? release : undefined}
      onLongPress={
        dictationMode === 'toggle'
          ? () => {
              if (dictation.isStarting || dictation.isRecording || dictation.isProcessing) {
                onDictationCancel()
              }
            }
          : keepHeldPressThroughLongPress
      }
      accessibilityRole="button"
      aria-busy={dictation.isStarting || dictation.isProcessing}
      accessibilityLabel={dictationControlsCopy.mic({
        starting: dictation.isStarting,
        active: dictationActive,
        processing: dictation.isProcessing
      })}
    >
      <MobileDictationMicIcon
        active={dictationActive}
        processing={dictation.isProcessing}
        micSize={17}
        micStroke={2.4}
      />
    </Pressable>
  )
}
