import { useState } from 'react'
import { View, ScrollView, TextInput, Pressable } from 'react-native'
import { hostOs } from '../platform/host-os'
import {
  ArrowUp,
  ChevronDown,
  ChevronsRight,
  Keyboard as KeyboardIcon,
  Monitor,
  Plus,
  Smartphone
} from 'lucide-react-native'
import { triggerMediumImpact, triggerSelection } from '../platform/haptics'
import { createTerminalLiveAccessoryInput } from '../terminal/terminal-live-accessory-input'
import {
  getTerminalCommandKeyboardType,
  getTerminalLiveInputKeyboardType
} from '../terminal/terminal-keyboard-type'
import { MobileTerminalLiveInputStatus } from './MobileTerminalLiveInputStatus'
import {
  MobileTerminalInputActions,
  MobileTerminalInputRoundButton
} from './MobileTerminalInputActions'
import { MobileTerminalAccessoryKey } from './MobileTerminalAccessoryKey'
import { keepHeldPressThroughLongPress } from './held-press-long-press'
import { isTerminalPhoneDisplayMode } from './mobile-session-route-helpers'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-session-styles'
import { useKeyboardPersistingTaps } from '../platform/keyboard-persisting-taps'
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
  const accessoryBarKeepsKeyboard = useKeyboardPersistingTaps('always')
  const [commandFocused, setCommandFocused] = useState(false)
  const phoneMode = isTerminalPhoneDisplayMode(activeHandle, terminalModes)
  const hasCommandText = bufferedTerminalDraftState.input.trim().length > 0
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
        <View ref={accessoryBarKeepsKeyboard} style={styles.accessoryBar}>
          {/* Why: fixed keyboard escape hatch; outside ScrollView + shortcut path so it can't scroll away or be hidden (#5106). */}
          {keyboardLift > 0 && (
            <View style={styles.keyboardDismissSlot}>
              <MobileTerminalAccessoryKey
                onPress={dismissSoftwareKeyboard}
                accessibilityLabel="Dismiss keyboard"
                accessibilityHint="Hides the software keyboard and keeps the current terminal session open."
                glyph={
                  <View style={styles.keyboardDismissGlyph}>
                    <KeyboardIcon size={16} color={colors.textPrimary} strokeWidth={2} />
                    <ChevronDown
                      size={10}
                      color={colors.textPrimary}
                      strokeWidth={2.5}
                      style={styles.keyboardDismissChevron}
                    />
                  </View>
                }
              />
            </View>
          )}
          {/* Why: default tap handling makes the first accessory-key tap dismiss the keyboard and get swallowed (#5106). */}
          <ScrollView
            style={styles.accessoryScroll}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.accessoryContent}
            keyboardShouldPersistTaps="always"
          >
            {/* The mode chips name the current state; the label says which. */}
            <MobileTerminalAccessoryKey
              icon={phoneMode ? Smartphone : Monitor}
              label={phoneMode ? 'Phone' : 'Desktop'}
              sans
              disabled={!canSend}
              onPress={() => {
                if (activeHandle) {
                  void toggleDisplayMode(activeHandle)
                }
              }}
              accessibilityLabel={phoneMode ? 'Switch to desktop mode' : 'Switch to phone mode'}
            />
            <MobileTerminalAccessoryKey
              icon={ChevronsRight}
              label="Live"
              sans
              active={liveInputEnabled}
              // Why: offline, live mode is dead but the buffered box still composes — keep the escape hatch tappable (#6713).
              disabled={!canCompose}
              onPress={toggleLiveInput}
              accessibilityLabel={
                liveInputEnabled
                  ? 'Switch to buffered command input'
                  : 'Switch to live terminal input'
              }
            />
            <View style={styles.accessoryDivider} />
            {canPaste && (
              <MobileTerminalAccessoryKey
                label="Paste"
                sans
                disabled={!canSend}
                onPress={() => void handlePaste()}
                accessibilityLabel="Paste from clipboard"
              />
            )}
            {visibleBuiltInAccessoryKeys.map((key) => (
              <MobileTerminalAccessoryKey
                key={key.id}
                label={key.label}
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
                onLongPress={key.repeatable ? keepHeldPressThroughLongPress : undefined}
                accessibilityLabel={key.accessibilityLabel ?? `Send ${key.label}`}
              />
            ))}
            {customKeys.map((key) => (
              <MobileTerminalAccessoryKey
                key={key.id}
                label={key.label}
                custom
                disabled={!canSend}
                onPress={() => void handleAccessoryKey({ bytes: key.bytes })}
                onLongPress={() => {
                  triggerMediumImpact()
                  setDeleteKeyTarget(key)
                }}
                delayLongPress={400}
                accessibilityLabel={`Send ${key.label}`}
                accessibilityHint="Long press to remove this shortcut"
              />
            ))}
            <MobileTerminalAccessoryKey
              icon={Plus}
              onPress={() => setShowCustomKeyModal(true)}
              accessibilityLabel="Add custom shortcut"
            />
          </ScrollView>
        </View>

        {/* Input bar */}
        {liveInputEnabled ? (
          <View style={styles.inputBar}>
            <View style={[styles.inputBox, !canSend && styles.inputBoxDisabled]}>
              <Pressable
                style={styles.liveInputFocusTarget}
                disabled={!canSend}
                onPress={focusLiveInput}
                accessibilityRole="button"
                accessibilityLabel="Show keyboard for live terminal input"
                accessibilityHint="Typed text is sent directly to the active terminal"
              >
                {({ pressed }) => (
                  <View style={[styles.liveInputFocusRow, pressed && styles.liveInputFocusPressed]}>
                    <KeyboardIcon size={18} color={colors.textSecondary} strokeWidth={2} />
                    <MobileTerminalLiveInputStatus
                      dictation={dictation}
                      isAttaching={isAttaching}
                      liveInputText={liveInputCapture}
                    />
                  </View>
                )}
              </Pressable>
              <MobileTerminalInputActions
                canSend={canSend}
                isAttaching={isAttaching}
                dictation={dictation}
                dictationMode={dictationMode}
                dictationEnabled={dictationEnabled}
                onAttachImage={() => void attachImage('library')}
                onAttachFile={() => void attachImage('files')}
                onDictationToggle={handleDictationToggle}
                onDictationPressIn={handleDictationPressIn}
                onDictationPressOut={handleDictationPressOut}
                onDictationCancel={cancelDictation}
              />
            </View>
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
            <View
              style={[
                styles.inputBox,
                commandFocused && styles.inputBoxFocused,
                !canCompose && styles.inputBoxDisabled
              ]}
            >
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
                onFocus={() => setCommandFocused(true)}
                onBlur={() => setCommandFocused(false)}
                placeholder="Type a command…"
                placeholderTextColor={colors.textMuted}
                selectionColor={colors.accentBlue}
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
                onAttachImage={() => void attachImage('library')}
                onAttachFile={() => void attachImage('files')}
                onDictationToggle={handleDictationToggle}
                onDictationPressIn={handleDictationPressIn}
                onDictationPressOut={handleDictationPressOut}
                onDictationCancel={cancelDictation}
              />
              {/* An empty send still submits Enter, so it stays live; it lights up once there is text. */}
              <MobileTerminalInputRoundButton
                ready={canSend && hasCommandText}
                soft={!hasCommandText}
                disabled={!canSend}
                onPress={() => {
                  triggerSelection()
                  void handleSend()
                }}
                accessibilityLabel="Send command"
              >
                <ArrowUp
                  size={17}
                  color={canSend && hasCommandText ? colors.onPrimary : colors.textSecondary}
                  strokeWidth={2.4}
                />
              </MobileTerminalInputRoundButton>
            </View>
          </View>
        )}
      </View>
    )
  )
}
