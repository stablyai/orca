import type { RefObject } from 'react'
import { Platform, Pressable, TextInput, View, type StyleProp, type ViewStyle } from 'react-native'
import { Keyboard as KeyboardIcon } from 'lucide-react-native'
import { HardwareKeyboardCaptureView } from '@orca/expo-hardware-keyboard'
import { getTerminalLiveInputKeyboardType } from '../terminal/terminal-keyboard-type'
import type { TerminalLiveHardwareKeyEvent } from '../terminal/terminal-live-hardware-key-mapping'
import { colors } from '../theme/mobile-theme'
import { MobileTerminalLiveInputStatus } from './MobileTerminalLiveInputStatus'
import { MobileTerminalInputActions } from './MobileTerminalInputActions'

type DictationState = {
  readonly isStarting: boolean
  readonly isRecording: boolean
  readonly isProcessing: boolean
}

type Props = {
  readonly canSend: boolean
  readonly liveInputCapture: string
  readonly liveInputRef: RefObject<TextInput | null>
  readonly hardwareCaptureEnabled: boolean
  readonly showSoftInputOnFocus: boolean
  readonly isAttaching: boolean
  readonly dictation: DictationState
  readonly dictationMode: 'toggle' | 'hold'
  readonly styles: {
    readonly inputBar: StyleProp<ViewStyle>
    readonly liveInputBar: StyleProp<ViewStyle>
    readonly liveInputFocusTarget: StyleProp<ViewStyle>
    readonly liveInputFocusTargetPressed: StyleProp<ViewStyle>
    readonly liveInputFocusTargetDisabled: StyleProp<ViewStyle>
    readonly liveInputCapture: StyleProp<ViewStyle>
    readonly dictationButton: StyleProp<ViewStyle>
    readonly dictationButtonActive: StyleProp<ViewStyle>
    readonly sendButtonDisabled: StyleProp<ViewStyle>
  }
  readonly onFocusPress: () => void
  readonly onChangeText: (text: string) => void
  readonly onKeyPress: (event: { nativeEvent: { key: string } }) => void
  readonly onSubmitEditing: () => void
  readonly onHardwareKey: (event: { nativeEvent: TerminalLiveHardwareKeyEvent }) => void
  readonly onAttachImage: () => void
  readonly onAttachFile: () => void
  readonly onDictationToggle: () => void
  readonly onDictationPressIn: () => void
  readonly onDictationPressOut: () => void
  readonly onDictationCancel: () => void
}

export function MobileTerminalLiveInputBar({
  canSend,
  liveInputCapture,
  liveInputRef,
  hardwareCaptureEnabled,
  showSoftInputOnFocus,
  isAttaching,
  dictation,
  dictationMode,
  styles,
  onFocusPress,
  onChangeText,
  onKeyPress,
  onSubmitEditing,
  onHardwareKey,
  onAttachImage,
  onAttachFile,
  onDictationToggle,
  onDictationPressIn,
  onDictationPressOut,
  onDictationCancel
}: Props): React.JSX.Element {
  return (
    <View style={[styles.inputBar, styles.liveInputBar]}>
      <Pressable
        style={({ pressed }) => [
          styles.liveInputFocusTarget,
          pressed && styles.liveInputFocusTargetPressed,
          !canSend && styles.liveInputFocusTargetDisabled
        ]}
        disabled={!canSend}
        onPress={onFocusPress}
        accessibilityRole="button"
        accessibilityLabel="Show keyboard for live terminal input"
        accessibilityHint="Typed text is sent directly to the active terminal"
      >
        <KeyboardIcon size={16} color={colors.textSecondary} strokeWidth={2} />
        <MobileTerminalLiveInputStatus dictation={dictation} isAttaching={isAttaching} />
      </Pressable>
      <MobileTerminalInputActions
        canSend={canSend}
        isAttaching={isAttaching}
        dictation={dictation}
        dictationMode={dictationMode}
        buttonStyle={styles.dictationButton}
        activeButtonStyle={styles.dictationButtonActive}
        disabledButtonStyle={styles.sendButtonDisabled}
        onAttachImage={onAttachImage}
        onAttachFile={onAttachFile}
        onDictationToggle={onDictationToggle}
        onDictationPressIn={onDictationPressIn}
        onDictationPressOut={onDictationPressOut}
        onDictationCancel={onDictationCancel}
      />
      <HardwareKeyboardCaptureView
        enabled={hardwareCaptureEnabled}
        onHardwareKey={onHardwareKey}
        style={styles.liveInputCapture}
      >
        <TextInput
          ref={liveInputRef}
          style={styles.liveInputCapture}
          value={liveInputCapture}
          onChangeText={onChangeText}
          onKeyPress={onKeyPress}
          onSubmitEditing={onSubmitEditing}
          placeholder=""
          showSoftInputOnFocus={showSoftInputOnFocus}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          smartInsertDelete={false}
          // Why: iOS textContentType overrides autoComplete and can narrow the keyboard.
          autoComplete="off"
          keyboardType={getTerminalLiveInputKeyboardType(Platform.OS)}
          returnKeyType="default"
          blurOnSubmit={false}
          editable={canSend}
          importantForAutofill="no"
        />
      </HardwareKeyboardCaptureView>
    </View>
  )
}
