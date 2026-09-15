import { View, Text, ScrollView, TextInput, Pressable, Platform } from 'react-native'
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
import { KeypadLayoutToggle } from './KeypadLayoutToggle'
import { useMobileKeypadHeight } from './use-mobile-keypad-height'
import { useTerminalKeypadLayout } from './use-terminal-keypad-layout'
import { TerminalVirtualKeyboard, KEYBOARD_HEIGHT } from '../terminal/terminal-virtual-keyboard'
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

  const { keypadLayout, handleKeypadLayoutChange } =
    useTerminalKeypadLayout(dismissSoftwareKeyboard)
  const {
    height: keypadHeight,
    dragging: keypadDragging,
    panResponder: keypadPanResponder,
    measureContentHeight: measureKeypadContent
  } = useMobileKeypadHeight()

  const inputActions = (
    <MobileTerminalInputActions
      canSend={canSend}
      canPaste={canPaste}
      isAttaching={isAttaching}
      dictation={dictation}
      dictationMode={dictationMode}
      buttonStyle={styles.dictationButton}
      activeButtonStyle={styles.dictationButtonActive}
      disabledButtonStyle={styles.sendButtonDisabled}
      onPaste={() => void handlePaste()}
      onAttachImage={() => void attachImage('library')}
      onAttachFile={() => void attachImage('files')}
      onDictationToggle={handleDictationToggle}
      onDictationPressIn={handleDictationPressIn}
      onDictationPressOut={handleDictationPressOut}
      onDictationCancel={cancelDictation}
    />
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
        {keypadLayout === 'shortcuts' && (
          <View
            style={[styles.keypadResizeHandle, keypadDragging && styles.keypadResizeHandleActive]}
            hitSlop={{ top: 12, bottom: 12, left: 0, right: 0 }}
            accessibilityRole="adjustable"
            accessibilityLabel="Resize shortcut key area"
            {...keypadPanResponder.panHandlers}
          >
            <View style={styles.keypadResizeHandleGrip} />
          </View>
        )}
        <View style={styles.accessoryBar}>
          <ScrollView
            style={[
              styles.accessoryKeysScroll,
              { height: keypadLayout === 'shortcuts' ? keypadHeight : KEYBOARD_HEIGHT }
            ]}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            scrollEnabled={keypadLayout === 'shortcuts'}
            onContentSizeChange={(_width, contentHeight) => {
              if (keypadLayout === 'shortcuts') {
                measureKeypadContent(contentHeight)
              }
            }}
          >
            {keypadLayout === 'keyboard' ? (
              <TerminalVirtualKeyboard
                canSend={canSend}
                onSendBytes={(bytes) => void handleAccessoryKey({ bytes })}
              />
            ) : (
              <View style={styles.accessoryGrid}>
                {/* Why: fixed keyboard escape hatch; first in the grid so it can't scroll away or be hidden (#5106). */}
                {keyboardLift > 0 && (
                  <Pressable
                    style={({ pressed }) => [
                      styles.keyboardDismissKey,
                      pressed && styles.accessoryKeyPressed
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
                )}
                <Pressable
                  style={({ pressed }) => [
                    styles.accessoryKey,
                    pressed && styles.accessoryKeyPressed,
                    !canSend && styles.accessoryKeyDisabled
                  ]}
                  disabled={!canSend}
                  onPress={() => {
                    if (activeHandle) {
                      void toggleDisplayMode(activeHandle)
                    }
                  }}
                  accessibilityLabel={
                    isTerminalPhoneDisplayMode(activeHandle, terminalModes)
                      ? 'Switch to desktop mode'
                      : 'Switch to phone mode'
                  }
                >
                  {isTerminalPhoneDisplayMode(activeHandle, terminalModes) ? (
                    <Monitor size={14} color={canSend ? colors.textSecondary : colors.textMuted} />
                  ) : (
                    <Smartphone
                      size={14}
                      color={canSend ? colors.textSecondary : colors.textMuted}
                    />
                  )}
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.accessoryKey,
                    liveInputEnabled && styles.accessoryKeyActive,
                    pressed && styles.accessoryKeyPressed,
                    !canCompose && styles.accessoryKeyDisabled
                  ]}
                  // Why: offline, live mode is dead but the buffered box still composes — keep the escape hatch tappable (#6713).
                  disabled={!canCompose}
                  onPress={toggleLiveInput}
                  accessibilityLabel={
                    liveInputEnabled
                      ? 'Switch to buffered command input'
                      : 'Switch to live terminal input'
                  }
                >
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
                </Pressable>
                {visibleBuiltInAccessoryKeys.map((key) => (
                  <Pressable
                    key={key.id}
                    style={({ pressed }) => [
                      styles.accessoryKey,
                      pressed && styles.accessoryKeyPressed,
                      !canSend && styles.accessoryKeyDisabled
                    ]}
                    disabled={!canSend}
                    onPressIn={() => {
                      if (!key.repeatable) {
                        return
                      }
                      const input = createTerminalLiveAccessoryInput(key)
                      void handleAccessoryKey(input)
                      startAccessoryRepeat(input)
                    }}
                    onPressOut={() => {
                      if (key.repeatable) {
                        stopAccessoryRepeat()
                      }
                    }}
                    onPress={() => {
                      if (key.repeatable) {
                        return
                      }
                      void handleAccessoryKey(createTerminalLiveAccessoryInput(key))
                    }}
                    accessibilityLabel={key.accessibilityLabel ?? `Send ${key.label}`}
                  >
                    <Text
                      style={[styles.accessoryKeyText, !canSend && styles.accessoryKeyTextDisabled]}
                    >
                      {key.label}
                    </Text>
                  </Pressable>
                ))}
                {customKeys.map((key) => (
                  <Pressable
                    key={key.id}
                    style={({ pressed }) => [
                      styles.accessoryKey,
                      styles.customAccessoryKey,
                      pressed && styles.accessoryKeyPressed,
                      !canSend && styles.accessoryKeyDisabled
                    ]}
                    disabled={!canSend}
                    onPress={() => void handleAccessoryKey({ bytes: key.bytes })}
                    onLongPress={() => {
                      triggerMediumImpact()
                      setDeleteKeyTarget(key)
                    }}
                    delayLongPress={400}
                    accessibilityLabel={`Send ${key.label}`}
                  >
                    <Text
                      style={[styles.accessoryKeyText, !canSend && styles.accessoryKeyTextDisabled]}
                    >
                      {key.label}
                    </Text>
                  </Pressable>
                ))}
                <Pressable
                  style={({ pressed }) => [
                    styles.accessoryKey,
                    pressed && styles.accessoryKeyPressed
                  ]}
                  onPress={() => setShowCustomKeyModal(true)}
                  accessibilityLabel="Add custom shortcut"
                >
                  <Plus size={14} color={colors.textSecondary} strokeWidth={2.2} />
                </Pressable>
              </View>
            )}
          </ScrollView>
        </View>

        {/* Input bar */}
        {liveInputEnabled ? (
          <View style={[styles.inputBar, styles.liveInputBar]}>
            <KeypadLayoutToggle layout={keypadLayout} onChange={handleKeypadLayoutChange} />
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
              <MobileTerminalLiveInputStatus
                dictation={dictation}
                isAttaching={isAttaching}
                liveInputText={liveInputCapture}
              />
            </Pressable>
            {inputActions}
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
            <KeypadLayoutToggle layout={keypadLayout} onChange={handleKeypadLayoutChange} />
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
            {inputActions}
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
