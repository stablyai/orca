import type { RefObject } from 'react'
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { ArrowUp, Keyboard as KeyboardIcon } from 'lucide-react-native'
import { OrcaKeyCaptureView, type NativeKeyEvent } from '@orca/expo-hardware-keyboard'
import { colors } from '../theme/mobile-theme'
import { MobileTerminalInputActions } from './MobileTerminalInputActions'
import { MobileTerminalLiveInputStatus } from './MobileTerminalLiveInputStatus'
import {
  getTerminalCommandKeyboardType,
  getTerminalLiveInputKeyboardType
} from '../terminal/terminal-keyboard-type'
import type { useMobileDictation } from '../hooks/use-mobile-dictation'
import { styles } from './mobile-session-styles'

type Dictation = ReturnType<typeof useMobileDictation>

type TerminalSessionInputBarProps = {
  readonly autocompleteEnabled: boolean
  readonly canCompose: boolean
  readonly canSend: boolean
  readonly commandInputRef: RefObject<TextInput | null>
  readonly dictation: Dictation
  readonly dictationMode: 'toggle' | 'hold'
  readonly focusLiveInput: () => void
  readonly handleLiveInputChange: (text: string) => void
  readonly handleLiveInputKeyPress: (event: { nativeEvent: { key: string } }) => void
  readonly handleLiveInputSubmit: () => void
  readonly handleNativeKey: (event: { nativeEvent: NativeKeyEvent }) => void
  readonly handleSend: () => void
  readonly hardwareKeyboardConnected: boolean
  readonly input: string
  readonly isAttaching: boolean
  readonly liveInputCapture: string
  readonly liveInputEnabled: boolean
  readonly liveInputRef: RefObject<TextInput | null>
  readonly onAttachFile: () => void
  readonly onAttachImage: () => void
  readonly onCancelDictation: () => void
  readonly onDictationPressIn: () => void
  readonly onDictationPressOut: () => void
  readonly onDictationToggle: () => void
  readonly setInput: (text: string) => void
}

// The session screen's bottom input bar: whichever of three input surfaces is
// live right now — hardware-keyboard capture, TextInput-backed live input, or
// buffered command entry — chosen by liveInputEnabled/hardwareKeyboardConnected.
// Extracted out of the session screen component to keep that file under its
// max-lines budget; see useHardwareKeyInput for how the first branch's state
// is produced.
export function TerminalSessionInputBar({
  autocompleteEnabled,
  canCompose,
  canSend,
  commandInputRef,
  dictation,
  dictationMode,
  focusLiveInput,
  handleLiveInputChange,
  handleLiveInputKeyPress,
  handleLiveInputSubmit,
  handleNativeKey,
  handleSend,
  hardwareKeyboardConnected,
  input,
  isAttaching,
  liveInputCapture,
  liveInputEnabled,
  liveInputRef,
  onAttachFile,
  onAttachImage,
  onCancelDictation,
  onDictationPressIn,
  onDictationPressOut,
  onDictationToggle,
  setInput
}: TerminalSessionInputBarProps) {
  const inputActionsProps = {
    canSend,
    isAttaching,
    dictation,
    dictationMode,
    buttonStyle: styles.dictationButton,
    activeButtonStyle: styles.dictationButtonActive,
    disabledButtonStyle: styles.sendButtonDisabled,
    onAttachImage,
    onAttachFile,
    onDictationToggle,
    onDictationPressIn,
    onDictationPressOut,
    onDictationCancel: onCancelDictation
  }

  if (liveInputEnabled && hardwareKeyboardConnected) {
    return (
      <View style={[styles.inputBar, styles.liveInputBar]}>
        {/* Why: rendered first (behind the visible row below) so it never
            swallows taps on dictation/attach — it's a non-text-input first
            responder that captures hardware keys without showing the
            software keyboard. canSend gates focus so a disconnected session
            doesn't eat keys. */}
        <OrcaKeyCaptureView
          active={canSend}
          style={StyleSheet.absoluteFill}
          onKey={handleNativeKey}
        />
        <KeyboardIcon size={16} color={colors.textSecondary} strokeWidth={2} />
        <Text style={styles.liveInputHint} numberOfLines={1}>
          Physical keyboard sends directly to terminal
        </Text>
        <MobileTerminalInputActions {...inputActionsProps} />
      </View>
    )
  }

  if (liveInputEnabled) {
    return (
      <View style={[styles.inputBar, styles.liveInputBar]}>
        <Pressable
          style={({ pressed }) => [
            styles.liveInputFocusTarget,
            pressed && styles.liveInputFocusTargetPressed,
            !canSend && styles.liveInputFocusTargetDisabled
          ]}
          disabled={!canSend}
          onPress={focusLiveInput}
          accessibilityRole="button"
          accessibilityLabel="Show keyboard for live terminal input"
          accessibilityHint="Typed text is sent directly to the active terminal"
        >
          <KeyboardIcon size={16} color={colors.textSecondary} strokeWidth={2} />
          <MobileTerminalLiveInputStatus
            dictation={dictation}
            isAttaching={isAttaching}
            liveInputText={liveInputCapture}
          />
        </Pressable>
        <MobileTerminalInputActions {...inputActionsProps} />
        <TextInput
          ref={liveInputRef}
          style={styles.liveInputCapture}
          value={liveInputCapture}
          onChangeText={handleLiveInputChange}
          onKeyPress={handleLiveInputKeyPress}
          onSubmitEditing={handleLiveInputSubmit}
          placeholder=""
          showSoftInputOnFocus
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          smartInsertDelete={false}
          // Why: iOS textContentType overrides autoComplete and can narrow the keyboard; keep IME switching available.
          autoComplete="off"
          keyboardType={getTerminalLiveInputKeyboardType(Platform.OS)}
          returnKeyType="default"
          blurOnSubmit={false}
          editable={canSend}
          importantForAutofill="no"
        />
      </View>
    )
  }

  return (
    <View style={styles.inputBar}>
      <TextInput
        ref={commandInputRef}
        // Why: Android caches IME inputType at mount, so toggling autocomplete must remount there; iOS updates in place.
        key={
          Platform.OS === 'android'
            ? autocompleteEnabled
              ? 'cmd-input-ac-on'
              : 'cmd-input-ac-off'
            : 'cmd-input'
        }
        style={styles.textInput}
        value={input}
        // Why: iOS kills active dictation/IME if JS writes a value differing from native text; store raw, normalize at send.
        onChangeText={setInput}
        placeholder="Type a command…"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={autocompleteEnabled}
        spellCheck={autocompleteEnabled}
        smartInsertDelete={false}
        // Why: not autofill content, but keyboard must stay default so non-Latin IMEs remain selectable.
        autoComplete="off"
        keyboardType={getTerminalCommandKeyboardType(Platform.OS, autocompleteEnabled)}
        returnKeyType="send"
        // Why: composing is local — an outage must not lock the field or discard typed text (#6713).
        editable={canCompose}
        onSubmitEditing={handleSend}
      />
      <MobileTerminalInputActions {...inputActionsProps} />
      <Pressable
        style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
        disabled={!canSend}
        onPress={handleSend}
        accessibilityLabel="Send command"
      >
        <ArrowUp size={18} color={colors.textSecondary} strokeWidth={2.5} />
      </Pressable>
    </View>
  )
}
