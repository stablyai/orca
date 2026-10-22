import { View, TextInput, Pressable } from 'react-native'
import { hostOs } from '../platform/host-os'
import { ArrowUp, Keyboard as KeyboardIcon } from 'lucide-react-native'
import {
  getTerminalCommandKeyboardType,
  getTerminalLiveInputKeyboardType
} from '../terminal/terminal-keyboard-type'
import { MobileTerminalLiveInputStatus } from './MobileTerminalLiveInputStatus'
import { MobileTerminalInputActions } from './MobileTerminalInputActions'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'
import { MobileSessionCommandAccessoryBar } from './MobileSessionCommandAccessoryBar'
import { useMobileCommandInputField } from './use-mobile-command-input-field'

/**
 * Terminal command dock. Return inserts a newline; the send button submits the whole buffer.
 */
export function MobileSessionCommandDock({ controller }: { controller: MobileSessionController }) {
  const {
    insets,
    bufferedTerminalDraftState,
    autocompleteEnabled,
    liveInputCapture,
    dictationEnabled,
    bindCommandField,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    bindLiveInputField,
    submitLiveInput,
    canSend,
    canCompose,
    liveInputEnabled,
    focusLiveInput,
    showNativeChat,
    dictation,
    cancelDictation,
    handleDictationToggle,
    handleDictationPressIn,
    handleDictationPressOut,
    dictationMode,
    handleSend,
    isAttaching,
    attachImage,
    activeMarkdownTab,
    activeFileTab,
    activeBrowserTab,
    keyboardLift
  } = controller

  const {
    commandFieldRef,
    emptyResetEpoch,
    inputHeight,
    onContentSizeChange,
    onCommandFieldFocus,
    onCommandFieldBlur
  } = useMobileCommandInputField({
    bindCommandField,
    input: bufferedTerminalDraftState.input
  })

  const inputActionsProps = {
    canSend,
    isAttaching,
    dictation,
    dictationMode,
    dictationEnabled,
    buttonStyle: styles.dictationButton,
    activeButtonStyle: styles.dictationButtonActive,
    disabledButtonStyle: styles.sendButtonDisabled,
    onAttachImage: () => void attachImage('library'),
    onAttachFile: () => void attachImage('files'),
    onDictationToggle: handleDictationToggle,
    onDictationPressIn: handleDictationPressIn,
    onDictationPressOut: handleDictationPressOut,
    onDictationCancel: cancelDictation
  }

  const commandField = (
    <TextInput
      ref={commandFieldRef}
      // Why: Android caches IME inputType at mount, so toggling autocomplete must remount there;
      // cycling emptyResetEpoch on text clear forcibly tears down any lingering Android ActionMode/PopupWindow.
      key={
        hostOs() === 'android'
          ? `cmd-input-${emptyResetEpoch}-${autocompleteEnabled ? 'ac-on' : 'ac-off'}`
          : 'cmd-input'
      }
      style={[styles.textInput, { height: inputHeight }]}
      value={bufferedTerminalDraftState.input}
      // Why: iOS kills active dictation/IME if JS writes a value differing from native text; store raw, normalize at send.
      onChangeText={bufferedTerminalDraftState.setInput}
      onContentSizeChange={onContentSizeChange}
      placeholder="Type a command…"
      placeholderTextColor={colors.textMuted}
      autoCapitalize="none"
      autoCorrect={autocompleteEnabled}
      spellCheck={autocompleteEnabled}
      smartInsertDelete={false}
      dataDetectorTypes="none"
      // Why: not autofill content, but keyboard must stay default so non-Latin IMEs remain selectable.
      autoComplete="off"
      keyboardType={getTerminalCommandKeyboardType(hostOs(), autocompleteEnabled)}
      returnKeyType="default"
      multiline
      textAlignVertical="top"
      submitBehavior="newline"
      blurOnSubmit={false}
      // Why: composing is local — an outage must not lock the field or discard typed text (#6713).
      editable={canCompose}
      onSubmitEditing={() => void handleSend()}
      onFocus={onCommandFieldFocus}
      onBlur={onCommandFieldBlur}
    />
  )

  const sendCommandButton = (
    <Pressable
      style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
      disabled={!canSend}
      onPress={() => void handleSend()}
      accessibilityLabel="Send command"
    >
      <ArrowUp size={18} color={colors.textSecondary} strokeWidth={2.5} />
    </Pressable>
  )

  return (
    !activeMarkdownTab &&
    !activeFileTab &&
    !activeBrowserTab &&
    !showNativeChat && (
      <View
        style={[
          styles.commandDock,
          { paddingBottom: insets.bottom, transform: [{ translateY: -keyboardLift }] }
        ]}
      >
        {/* Accessory keys */}
        <MobileSessionCommandAccessoryBar controller={controller} />

        {/* Input bar */}
        {liveInputEnabled ? (
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
              ref={bindLiveInputField}
              style={styles.liveInputCapture}
              value={liveInputCapture}
              onChange={handleLiveInputChange}
              onKeyPress={handleLiveInputKeyPress}
              onSubmitEditing={submitLiveInput}
              placeholder=""
              showSoftInputOnFocus
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              smartInsertDelete={false}
              // Why: iOS textContentType overrides autoComplete and can narrow the keyboard; keep IME switching available.
              autoComplete="off"
              keyboardType={getTerminalLiveInputKeyboardType(hostOs())}
              returnKeyType="default"
              blurOnSubmit={false}
              editable={canSend}
              importantForAutofill="no"
            />
          </View>
        ) : (
          <View style={styles.inputBar}>
            {commandField}
            <MobileTerminalInputActions {...inputActionsProps} />
            {sendCommandButton}
          </View>
        )}
      </View>
    )
  )
}
