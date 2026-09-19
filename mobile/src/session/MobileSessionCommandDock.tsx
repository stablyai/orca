import { MobileAccessoryKeyBar } from '../components/keyboard-accessory/MobileAccessoryKeyBar'
import { View, TextInput, Pressable, Platform } from 'react-native'
import {
  ArrowUp,
  ChevronDown,
  ChevronsRight,
  Keyboard as KeyboardIcon,
  Monitor,
  Plus,
  Smartphone
} from 'lucide-react-native'
import { triggerMediumImpact } from '../platform/haptics'
import { createTerminalLiveAccessoryInput } from '../terminal/terminal-live-accessory-input'
import {
  getTerminalCommandKeyboardType,
  getTerminalLiveInputKeyboardType
} from '../terminal/terminal-keyboard-type'
import { MobileTerminalLiveInputStatus } from './MobileTerminalLiveInputStatus'
import { MobileTerminalInputActions } from './MobileTerminalInputActions'
import { isTerminalPhoneDisplayMode } from './mobile-session-route-helpers'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'

export function MobileSessionCommandDock({ controller }: { controller: MobileSessionController }) {
  const {
    insets,
    bufferedTerminalDraftState,
    autocompleteEnabled,
    liveInputCapture,
    activeHandle,
    customKeys,
    setShowCustomKeyModal,
    setDeleteKeyTarget,
    visibleBuiltInAccessoryKeys,
    terminalModes,
    canPaste,
    dictationMode,
    liveInputRef,
    commandInputRef,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    handleLiveInputSubmit,
    getLiveInteractionGeneration,
    getSendCompletionGeneration,
    dismissKeyboardAfterAgentSend,
    activeSessionTab,
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
    toggleDisplayMode,
    handleSend,
    handleAccessoryKey,
    dismissSoftwareKeyboard,
    toggleLiveInput,
    stopAccessoryRepeat,
    startAccessoryRepeat,
    handlePaste,
    isAttaching,
    attachImage,
    activeMarkdownTab,
    activeFileTab,
    activeBrowserTab,
    keyboardLift
  } = controller
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
        <MobileAccessoryKeyBar
          disabled={!canSend}
          leading={
            // Keep keyboard dismissal outside scrolling and shortcut customization (#5106).
            keyboardLift > 0 ? (
              <Pressable
                style={({ pressed }) => [
                  styles.keyboardDismissKey,
                  pressed && styles.keyboardDismissKeyPressed
                ]}
                onPress={dismissSoftwareKeyboard}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Dismiss keyboard"
                accessibilityHint="Hides the software keyboard and keeps the current terminal session open."
              >
                <View style={styles.keyboardDismissGlyph}>
                  <KeyboardIcon size={15} color={colors.textSecondary} strokeWidth={2} />
                  <ChevronDown
                    size={10}
                    color={colors.textSecondary}
                    strokeWidth={2.5}
                    style={styles.keyboardDismissChevron}
                  />
                </View>
              </Pressable>
            ) : null
          }
          keys={[
            {
              id: 'display-mode',
              icon: isTerminalPhoneDisplayMode(activeHandle, terminalModes) ? (
                <Monitor size={14} color={canSend ? colors.textSecondary : colors.textMuted} />
              ) : (
                <Smartphone size={14} color={canSend ? colors.textSecondary : colors.textMuted} />
              ),
              onPress: () => {
                if (activeHandle) {
                  void toggleDisplayMode(activeHandle)
                }
              },
              accessibilityLabel: isTerminalPhoneDisplayMode(activeHandle, terminalModes)
                ? 'Switch to desktop mode'
                : 'Switch to phone mode'
            },
            {
              id: 'live-input',
              // Buffered input remains available while disconnected.
              disabled: !canCompose,
              active: liveInputEnabled,
              icon: (
                <ChevronsRight
                  size={14}
                  color={
                    liveInputEnabled
                      ? colors.bgBase
                      : canCompose
                        ? colors.textSecondary
                        : colors.textMuted
                  }
                />
              ),
              onPress: toggleLiveInput,
              accessibilityLabel: liveInputEnabled
                ? 'Switch to buffered command input'
                : 'Switch to live terminal input'
            },
            ...(canPaste
              ? [
                  {
                    id: 'paste',
                    label: 'Paste',
                    onPress: () => void handlePaste(),
                    accessibilityLabel: 'Paste from clipboard'
                  }
                ]
              : []),
            ...visibleBuiltInAccessoryKeys.map((key) => ({
              id: key.id,
              label: key.label,
              accessibilityLabel: key.accessibilityLabel ?? `Send ${key.label}`,
              onPressIn: key.repeatable
                ? () => {
                    const input = createTerminalLiveAccessoryInput(key)
                    void handleAccessoryKey(input)
                    startAccessoryRepeat(input)
                  }
                : undefined,
              onPressOut: key.repeatable ? () => stopAccessoryRepeat() : undefined,
              onPress: key.repeatable
                ? undefined
                : () => void handleAccessoryKey(createTerminalLiveAccessoryInput(key))
            })),
            ...customKeys.map((key) => ({
              id: key.id,
              label: key.label,
              bordered: true,
              accessibilityLabel: `Send ${key.label}`,
              onPress: () => void handleAccessoryKey({ bytes: key.bytes }),
              onLongPress: () => {
                triggerMediumImpact()
                setDeleteKeyTarget(key)
              },
              delayLongPress: 400
            })),
            {
              id: 'add-custom',
              icon: <Plus size={14} color={colors.textSecondary} strokeWidth={2.2} />,
              disabled: false,
              onPress: () => setShowCustomKeyModal(true),
              accessibilityLabel: 'Add custom shortcut'
            }
          ]}
        />

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
            <MobileTerminalInputActions
              canSend={canSend}
              isAttaching={isAttaching}
              dictation={dictation}
              dictationMode={dictationMode}
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
              ref={liveInputRef}
              style={styles.liveInputCapture}
              value={liveInputCapture}
              onChange={handleLiveInputChange}
              onKeyPress={handleLiveInputKeyPress}
              onSubmitEditing={() => {
                const submit = handleLiveInputSubmit()
                const sendOrigin = {
                  tab: activeSessionTab,
                  generation: getSendCompletionGeneration(),
                  interaction: getLiveInteractionGeneration()
                }
                void submit.then((accepted) =>
                  dismissKeyboardAfterAgentSend(
                    sendOrigin,
                    accepted && sendOrigin.interaction === getLiveInteractionGeneration()
                  )
                )
              }}
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
        ) : (
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
              keyboardType={getTerminalCommandKeyboardType(Platform.OS, autocompleteEnabled)}
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
