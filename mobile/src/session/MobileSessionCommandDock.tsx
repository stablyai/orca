import { View, Text, ScrollView, TextInput, Pressable } from 'react-native'
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
import { triggerMediumImpact } from '../platform/haptics'
import { createTerminalLiveAccessoryInput } from '../terminal/terminal-live-accessory-input'
import {
  getTerminalCommandKeyboardType,
  getTerminalLiveInputKeyboardType
} from '../terminal/terminal-keyboard-type'
import { MobileTerminalLiveInputStatus } from './MobileTerminalLiveInputStatus'
import { MobileTerminalInputActions } from './MobileTerminalInputActions'
import { MobileRemoteDraftBar, MobileRemoteDraftFetchActions } from './MobileRemoteDraftControls'
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
    remoteDraftSession,
    remoteDraftConflict,
    remoteDraftUncertain,
    loadRemoteDraft,
    saveRemoteDraft,
    exitRemoteDraft,
    reloadConflict,
    keepConflictMine,
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
        <View ref={accessoryBarKeepsKeyboard} style={styles.accessoryBar}>
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
          <ScrollView
            style={styles.accessoryScroll}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.accessoryContent}
            keyboardShouldPersistTaps="always"
          >
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
                <Smartphone size={14} color={canSend ? colors.textSecondary : colors.textMuted} />
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
            {canPaste && (
              <Pressable
                style={({ pressed }) => [
                  styles.accessoryKey,
                  pressed && styles.accessoryKeyPressed,
                  !canSend && styles.accessoryKeyDisabled
                ]}
                disabled={!canSend}
                onPress={() => void handlePaste()}
                accessibilityLabel="Paste from clipboard"
              >
                <Text
                  style={[styles.accessoryKeyText, !canSend && styles.accessoryKeyTextDisabled]}
                >
                  Paste
                </Text>
              </Pressable>
            )}
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
                onLongPress={key.repeatable ? keepHeldPressThroughLongPress : undefined}
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
              style={({ pressed }) => [styles.accessoryKey, pressed && styles.accessoryKeyPressed]}
              onPress={() => setShowCustomKeyModal(true)}
              accessibilityLabel="Add custom shortcut"
            >
              <Plus size={14} color={colors.textSecondary} strokeWidth={2.2} />
            </Pressable>
          </ScrollView>
        </View>

        <MobileRemoteDraftBar
          editing={Boolean(remoteDraftSession)}
          changed={Boolean(remoteDraftConflict)}
          uncertain={remoteDraftUncertain}
          onReload={reloadConflict}
          onKeepMine={keepConflictMine}
          onExit={exitRemoteDraft}
        />

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
              autoComplete="off"
              keyboardType={getTerminalLiveInputKeyboardType(hostOs())}
              returnKeyType="default"
              blurOnSubmit={false}
              editable={canSend}
              importantForAutofill="no"
            />
          </View>
        ) : (
          <View style={[styles.inputBar, remoteDraftSession && styles.inputBarMultiline]}>
            <TextInput
              ref={bindCommandField}
              key={
                hostOs() === 'android'
                  ? autocompleteEnabled
                    ? 'cmd-input-ac-on'
                    : 'cmd-input-ac-off'
                  : 'cmd-input'
              }
              style={[styles.textInput, remoteDraftSession && styles.textInputMultiline]}
              value={bufferedTerminalDraftState.input}
              multiline={Boolean(remoteDraftSession)}
              textAlignVertical={remoteDraftSession ? 'top' : 'center'}
              // Why: iOS kills active dictation/IME if JS writes a value differing from native text; store raw, normalize at send.
              onChangeText={bufferedTerminalDraftState.setInput}
              placeholder="Type a command…"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={autocompleteEnabled}
              spellCheck={autocompleteEnabled}
              smartInsertDelete={false}
              autoComplete="off"
              keyboardType={getTerminalCommandKeyboardType(hostOs(), autocompleteEnabled)}
              returnKeyType={remoteDraftSession ? 'default' : 'send'}
              blurOnSubmit={false}
              // Why: composing is local — an outage must not lock the field or discard typed text (#6713).
              editable={canCompose}
              // Why: in draft mode Return must insert a newline; the arrow is the only submit.
              onSubmitEditing={remoteDraftSession ? undefined : () => void handleSend()}
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
            <MobileRemoteDraftFetchActions
              canSend={canSend}
              editing={Boolean(remoteDraftSession)}
              onLoad={loadRemoteDraft}
              onSave={() => void saveRemoteDraft()}
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
