import { useContext, useState, type RefObject } from 'react'
import {
  ActivityIndicator,
  Pressable,
  View,
  type HostInstance,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import { ChevronDown, Keyboard as KeyboardIcon, Plus } from 'lucide-react-native'
import { ActionSheetModal } from '../../../components/sheets/ActionSheetModal'
import { mobileNativeChatAttachActions } from '../../../session/native-chat/composer/attachments/mobile-native-chat-attach-actions'
import { stylesSheet as sessionStylesSheet } from '../../../session/mobile-session-styles'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStylesSheet
} from '../../../components/composer-input/composer-input-styles'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useMobileColors } from '../../../theme/use-mobile-color-scheme'
import { useThemedStyles } from '../../../theme/themed-styles'
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

type MobileTerminalLeadingButtonProps = {
  readonly canSend: boolean
  readonly isAttaching: boolean
  /** The keyboard is up: the slot hides it instead, so neither the field nor the key row moves. */
  readonly keyboardUp: boolean
  /** A recording is live or failed; an upload now would land in the middle of the dictated text. */
  readonly dictating: boolean
  readonly buttonStyle: StyleProp<ViewStyle>
  readonly disabledButtonStyle: StyleProp<ViewStyle>
  readonly onAttachImage: () => void
  readonly onAttachFile: () => void
  readonly onDismissKeyboard: () => void
}

/** The mic, or Retry for a recording that failed. */
export function MobileTerminalInputActions(props: MobileTerminalDictationButtonProps) {
  const live = useContext(MobileDictationLiveContext)
  // A kept failure is cleared by every start and Retry, so it never shows while dictating.
  const failureReason = live?.failureReason ?? null
  return failureReason !== null && live ? (
    <MobileDictationRetryButton onRetry={live.retry} labelled={false} />
  ) : (
    <MobileTerminalDictationButton {...props} />
  )
}

/** The field's leading slot: + for a photo or file, or hide-keyboard while the keyboard is up. */
export function MobileTerminalLeadingButton({
  canSend,
  isAttaching,
  keyboardUp,
  dictating,
  buttonStyle,
  disabledButtonStyle,
  onAttachImage,
  onAttachFile,
  onDismissKeyboard
}: MobileTerminalLeadingButtonProps) {
  const sessionStyles = useThemedStyles(sessionStylesSheet)
  const composerInputStyles = useThemedStyles(composerInputStylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const [attachOpen, setAttachOpen] = useState(false)
  if (keyboardUp) {
    return (
      <Pressable
        style={({ pressed }) => [buttonStyle, pressed && composerInputStyles.pressed]}
        hitSlop={COMPOSER_CONTROL_HIT_SLOP}
        onPress={onDismissKeyboard}
        accessibilityRole="button"
        accessibilityLabel={t('session.accessoryKeys.dismissKeyboard', 'Dismiss keyboard')}
      >
        <View style={sessionStyles.keyboardDismissGlyph}>
          <KeyboardIcon size={15} color={colors.textPrimary} strokeWidth={2} />
          <ChevronDown
            size={10}
            color={colors.textPrimary}
            strokeWidth={2.5}
            style={sessionStyles.keyboardDismissChevron}
          />
        </View>
      </Pressable>
    )
  }
  return (
    <>
      <Pressable
        style={({ pressed }) => [
          buttonStyle,
          pressed && composerInputStyles.pressed,
          (!canSend || isAttaching || dictating) && disabledButtonStyle
        ]}
        disabled={!canSend || isAttaching || dictating}
        hitSlop={COMPOSER_CONTROL_HIT_SLOP}
        onPress={() => setAttachOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={
          isAttaching
            ? t('session.terminalLiveInputStatus.uploading', 'Uploading…')
            : t('session.terminalInputActions.attach', 'Attach a photo or file')
        }
      >
        {isAttaching ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : (
          <Plus size={19} color={colors.textPrimary} strokeWidth={2} />
        )}
      </Pressable>
      {/* Uploads go through host RPC, so remote and SSH terminals attach the same way as local ones. */}
      <ActionSheetModal
        visible={attachOpen}
        onClose={() => setAttachOpen(false)}
        actions={mobileNativeChatAttachActions({
          onPhotos: onAttachImage,
          onFiles: onAttachFile,
          t
        })}
      />
    </>
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
  const composerInputStyles = useThemedStyles(composerInputStylesSheet)
  const t = useMobileTranslation()
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
      accessibilityLabel={dictationControlsCopy.mic(
        {
          starting: dictation.isStarting,
          active: dictationActive,
          processing: dictation.isProcessing
        },
        t
      )}
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
