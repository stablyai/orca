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
import { MobileSessionAccessoryKeys } from './MobileSessionAccessoryKeys'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'

// Both fields must remain focusable during the tap that hands the keyboard to the other mode.
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
  keysInRail
}: {
  controller: MobileSessionController
  keysInRail: boolean
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
                styles.liveInputCapture,
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
              ref={bindCommandField}
              // Why: Android caches IME inputType at mount, so toggling autocomplete must remount there; iOS updates in place.
              key={
                hostOs() === 'android'
                  ? autocompleteEnabled
                    ? 'cmd-input-ac-on'
                    : 'cmd-input-ac-off'
                  : 'cmd-input'
              }
              style={[
                styles.textInput,
                styles.commandFieldInput,
                commandDictationPreview && styles.commandFieldInputHidden
              ]}
              value={bufferedTerminalDraftState.input}
              // Why: iOS kills active dictation/IME if JS writes a value differing from native text; store raw, normalize at send.
              onChangeText={bufferedTerminalDraftState.setInput}
              onSelectionChange={(e) => {
                commandFieldAnchorRef.current = {
                  handle: activeHandle,
                  anchor: readMobileDictationAnchor(e, bufferedTerminalDraftState.input)
                }
              }}
              // The preview stands in for an empty draft, so its placeholder must not show through.
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
              // Why: not autofill content, but keyboard must stay default so non-Latin IMEs remain selectable.
              autoComplete="off"
              keyboardType={getTerminalCommandKeyboardType(hostOs(), autocompleteEnabled)}
              returnKeyType="send"
              blurOnSubmit={false}
              // Why: composing is local — an outage must not lock the field or discard typed text (#6713).
              editable={canCompose}
              tabIndex={liveInputEnabled ? -1 : 0}
              onSubmitEditing={() => void handleSend()}
            />
            {!liveInputEnabled && commandDictationPreview ? (
              <MobileTerminalCommandDictationPreview
                draft={bufferedTerminalDraftState.input}
                preview={commandDictationPreview}
              />
            ) : null}
          </View>
          <MobileTerminalInputActions
            canSend={canSend}
            isAttaching={isAttaching}
            dictation={dictation}
            dictationMode={dictationMode}
            dictationEnabled={dictationEnabled}
            meterHalo={liveInputEnabled ? undefined : dictation.meter}
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
