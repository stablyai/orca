import { useEffect, useRef } from 'react'
import { View, TextInput, Pressable } from 'react-native'
import { hostOs } from '../platform/host-os'
import { ArrowUp } from 'lucide-react-native'
import {
  getTerminalCommandKeyboardType,
  getTerminalLiveInputKeyboardType
} from '../terminal/terminal-keyboard-type'
import { MobileTerminalLiveInputStatus } from './MobileTerminalLiveInputStatus'
import { MobileTerminalCommandDictationPreview } from './MobileTerminalCommandDictationPreview'
import { readMobileDictationAnchor } from '../dictation/mobile-dictation-text-insertion'
import { MobileTerminalInputActions } from './MobileTerminalInputActions'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'
import { MobileSessionCommandAccessoryBar } from './MobileSessionCommandAccessoryBar'
import { useMobileCommandInputField } from './use-mobile-command-input-field'

// Both fields stay mounted so a mode switch can move focus before the keyboard drops.
// Return inserts a newline; the send button submits the whole buffer.
const inactiveFieldStyle = { position: 'absolute', left: 0, right: 0, opacity: 0 } as const

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
  keysInRail = false
}: {
  controller: MobileSessionController
  keysInRail?: boolean
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
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
    dictation,
    commandDictationPreview,
    liveDictationText,
    commandFieldAnchorRef,
    activeHandle,
    cancelDictation,
    handleDictationToggle,
    handleDictationPressIn,
    handleDictationPressOut,
    handleSend,
    isAttaching,
    attachImage,
    keyboardLift
  } = controller

  const wasLiveInputEnabledRef = useRef(liveInputEnabled)
  const shouldFocusOnMount = wasLiveInputEnabledRef.current && !liveInputEnabled && keyboardLift > 0
  useEffect(() => {
    wasLiveInputEnabledRef.current = liveInputEnabled
  }, [liveInputEnabled])

  const {
    commandFieldRef,
    emptyResetEpoch,
    inputHeight,
    onContentSizeChange,
    onCommandFieldFocus,
    onCommandFieldBlur
  } = useMobileCommandInputField({
    bindCommandField,
    input: bufferedTerminalDraftState.input,
    shouldFocusOnMount
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
    meterHalo: liveInputEnabled ? undefined : dictation.meter,
    onAttachImage: () => void attachImage('library'),
    onAttachFile: () => void attachImage('files'),
    onDictationToggle: handleDictationToggle,
    onDictationPressIn: handleDictationPressIn,
    onDictationPressOut: handleDictationPressOut,
    onDictationCancel: cancelDictation
  }

  return (
    sessionCommandDockShown(controller) && (
      <View
        style={[
          styles.commandDock,
          { paddingBottom: insets.bottom, transform: [{ translateY: -keyboardLift }] }
        ]}
      >
        {keysInRail ? null : <MobileSessionCommandAccessoryBar controller={controller} />}
        <View style={styles.inputBar}>
          <View
            style={[styles.liveInputField, !liveInputEnabled && inactiveFieldStyle]}
            pointerEvents={liveInputEnabled ? 'auto' : 'none'}
            aria-hidden={!liveInputEnabled}
            accessibilityElementsHidden={!liveInputEnabled}
            importantForAccessibility={liveInputEnabled ? 'auto' : 'no-hide-descendants'}
          >
            <TextInput
              ref={bindLiveInputField}
              style={[
                styles.textInput,
                styles.commandFieldInput,
                { height: 34 },
                !canSend && styles.liveInputCaptureDisabled
              ]}
              value={liveInputCapture}
              onChange={handleLiveInputChange}
              onKeyPress={handleLiveInputKeyPress}
              onSubmitEditing={submitLiveInput}
              placeholder={t('session.terminalLiveInputStatus.liveInput', 'Live input')}
              placeholderTextColor={colors.textMuted}
              selectionColor={colors.accentBlue}
              accessibilityLabel={t('session.commandDock.liveInputLabel', 'Live terminal input')}
              accessibilityHint={t(
                'session.commandDock.liveInputHint',
                'Typed text is sent directly to the active terminal'
              )}
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
              tabIndex={liveInputEnabled ? 0 : -1}
            />
            {liveInputEnabled ? (
              <MobileTerminalLiveInputStatus
                dictation={dictation}
                dictationMode={dictationMode}
                heard={liveDictationText}
                isAttaching={isAttaching}
              />
            ) : null}
          </View>
          <View
            style={[styles.commandField, liveInputEnabled && inactiveFieldStyle]}
            pointerEvents={liveInputEnabled ? 'none' : 'auto'}
            aria-hidden={liveInputEnabled}
            accessibilityElementsHidden={liveInputEnabled}
            importantForAccessibility={liveInputEnabled ? 'no-hide-descendants' : 'auto'}
          >
            <TextInput
              ref={commandFieldRef}
              // Why: Android caches IME inputType at mount, so toggling autocomplete must remount there;
              // cycling emptyResetEpoch on text clear tears down a lingering ActionMode.
              key={
                hostOs() === 'android'
                  ? `cmd-input-${emptyResetEpoch}-${autocompleteEnabled ? 'ac-on' : 'ac-off'}`
                  : 'cmd-input'
              }
              style={[
                styles.textInput,
                styles.commandFieldInput,
                { height: inputHeight },
                commandDictationPreview && styles.commandFieldInputHidden
              ]}
              value={bufferedTerminalDraftState.input}
              // Why: iOS kills active dictation/IME if JS writes a value differing from native text; store raw, normalize at send.
              onChangeText={bufferedTerminalDraftState.setInput}
              onContentSizeChange={onContentSizeChange}
              onSelectionChange={(event) => {
                commandFieldAnchorRef.current = {
                  handle: activeHandle,
                  anchor: readMobileDictationAnchor(event, bufferedTerminalDraftState.input)
                }
              }}
              placeholder={
                commandDictationPreview
                  ? undefined
                  : t('session.commandDock.commandPlaceholder', 'Type a command…')
              }
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
              tabIndex={liveInputEnabled ? -1 : 0}
              onSubmitEditing={() => void handleSend()}
              onFocus={onCommandFieldFocus}
              onBlur={onCommandFieldBlur}
            />
            {!liveInputEnabled && commandDictationPreview ? (
              <MobileTerminalCommandDictationPreview
                draft={bufferedTerminalDraftState.input}
                preview={commandDictationPreview}
              />
            ) : null}
          </View>
          <MobileTerminalInputActions {...inputActionsProps} />
          {liveInputEnabled ? null : (
            <Pressable
              style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
              disabled={!canSend}
              onPress={() => void handleSend()}
              accessibilityLabel={t('session.commandDock.sendCommand', 'Send command')}
            >
              <ArrowUp size={18} color={colors.textSecondary} strokeWidth={2.5} />
            </Pressable>
          )}
        </View>
      </View>
    )
  )
}
