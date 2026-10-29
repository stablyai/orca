import { View, TextInput, Pressable } from 'react-native'
import { hostOs } from '../platform/host-os'
import { ArrowUp, Keyboard as KeyboardIcon } from 'lucide-react-native'
import {
  getTerminalCommandKeyboardType,
  getTerminalLiveInputKeyboardType
} from '../terminal/terminal-keyboard-type'
import { MobileTerminalLiveInputStatus } from './MobileTerminalLiveInputStatus'
import { MobileTerminalInputActions } from './MobileTerminalInputActions'
import { MobileSessionAccessoryKeys } from './MobileSessionAccessoryKeys'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'

// Markdown, file, browser and chat tabs bring their own input; only terminals get the dock and its keys.
export function sessionCommandDockShown(controller: MobileSessionController): boolean {
  return (
    !controller.activeMarkdownTab &&
    !controller.activeFileTab &&
    !controller.activeBrowserTab &&
    !controller.showNativeChat
  )
}

export function MobileSessionCommandDock({
  controller,
  keysInRail
}: {
  controller: MobileSessionController
  keysInRail: boolean
}) {
  useMobileColorScheme()
  const {
    insets,
    bufferedTerminalDraftState,
    autocompleteEnabled,
    liveInputCapture,
    dictationMode,
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
    dictation,
    cancelDictation,
    handleDictationToggle,
    handleDictationPressIn,
    handleDictationPressOut,
    handleSend,
    isAttaching,
    attachImage,
    keyboardLift
  } = controller
  return (
    sessionCommandDockShown(controller) && (
      <View
        style={[
          styles.commandDock,
          { paddingBottom: insets.bottom, transform: [{ translateY: -keyboardLift }] }
        ]}
      >
        {}
        {keysInRail ? null : <MobileSessionAccessoryKeys controller={controller} />}
        {}
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
                dictationMode={dictationMode}
                isAttaching={isAttaching}
                liveInputText={liveInputCapture}
              />
            </Pressable>
            <MobileTerminalInputActions
              canSend={canSend}
              isAttaching={isAttaching}
              dictation={dictation}
              dictationMode={dictationMode}
              dictationEnabled={dictationEnabled}
              buttonStyle={styles.dictationButton}
              activeButtonStyle={styles.dictationButtonActive}
              disabledButtonStyle={styles.sendButtonDisabled}
              onAttachImage={() => void attachImage('library')}
              onAttachFile={() => void attachImage('files')}
              onDictationToggle={handleDictationToggle}
              onDictationPressIn={handleDictationPressIn}
              onDictationPressOut={handleDictationPressOut}
              onDictationCancel={cancelDictation}
            />
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
            <TextInput
              ref={bindCommandField}
              // Why: Android caches IME inputType at mount, so toggling autocomplete must remount there; iOS updates in place.
              key={
                hostOs() === 'android'
                  ? autocompleteEnabled
                    ? 'cmd-input-ac-on'
                    : 'cmd-input-ac-off'
                  : 'cmd-input'
              }
              style={styles.textInput}
              value={bufferedTerminalDraftState.input}
              // Why: iOS kills active dictation/IME if JS writes a value differing from native text; store raw, normalize at send.
              onChangeText={bufferedTerminalDraftState.setInput}
              placeholder="Type a command…"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={autocompleteEnabled}
              spellCheck={autocompleteEnabled}
              smartInsertDelete={false}
              // Why: not autofill content, but keyboard must stay default so non-Latin IMEs remain selectable.
              autoComplete="off"
              keyboardType={getTerminalCommandKeyboardType(hostOs(), autocompleteEnabled)}
              returnKeyType="send"
              blurOnSubmit={false}
              // Why: composing is local — an outage must not lock the field or discard typed text (#6713).
              editable={canCompose}
              onSubmitEditing={() => void handleSend()}
            />
            <MobileTerminalInputActions
              canSend={canSend}
              isAttaching={isAttaching}
              dictation={dictation}
              dictationMode={dictationMode}
              dictationEnabled={dictationEnabled}
              buttonStyle={styles.dictationButton}
              activeButtonStyle={styles.dictationButtonActive}
              disabledButtonStyle={styles.sendButtonDisabled}
              onAttachImage={() => void attachImage('library')}
              onAttachFile={() => void attachImage('files')}
              onDictationToggle={handleDictationToggle}
              onDictationPressIn={handleDictationPressIn}
              onDictationPressOut={handleDictationPressOut}
              onDictationCancel={cancelDictation}
            />
            <Pressable
              style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
              disabled={!canSend}
              onPress={() => void handleSend()}
              accessibilityLabel="Send command"
            >
              <ArrowUp size={18} color={colors.textSecondary} strokeWidth={2.5} />
            </Pressable>
          </View>
        )}
      </View>
    )
  )
}
