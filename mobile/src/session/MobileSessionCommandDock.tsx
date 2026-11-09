import { useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { composerInputStyles as inputStyles } from '../components/composer-input/composer-input-styles'
import { TextField } from '../components/composer-input/TextField'
import {
  reconcileTerminalManualMaskOverride,
  resolveTerminalInputMaskedState
} from '../terminal/terminal-password-prompt'
import { MobileTerminalLiveInputStatus } from './MobileTerminalLiveInputStatus'
import {
  MobileTerminalPasswordMaskOverlay,
  MobileTerminalPasswordMaskToggle
} from './MobileTerminalPasswordMaskOverlay'
import { MobileTerminalInputActions } from './MobileTerminalInputActions'
import { MobileSessionAccessoryKeys } from './MobileSessionAccessoryKeys'
import { MobileTerminalMoreKeysSheet } from './MobileTerminalMoreKeysSheet'
import { sessionCommandDockShown } from './mobile-session-command-dock-shown'
import { useSessionTerminalKeyRail } from './use-session-terminal-key-rail'
import { terminalDockStyles as dockStyles } from './terminal-dock-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'
import { useMobileSessionKeyboardLift } from './use-mobile-session-keyboard-lift'
import { useLiveInputCaptureText } from './live-input-capture'

// The key row above one live field: every letter typed goes straight to the terminal, shell or agent.
export function MobileSessionCommandDock({ controller }: { controller: MobileSessionController }) {
  useMobileColorScheme()
  const rail = useSessionTerminalKeyRail(controller)
  const keyboardLift = useMobileSessionKeyboardLift(controller.dockBottomInset)
  const {
    activeHandle,
    insets,
    dictationMode,
    dictationEnabled,
    canSend,
    dictation,
    liveDictationText,
    cancelDictation,
    handleDictationToggle,
    handleDictationPressIn,
    handleDictationPressOut,
    isAttaching,
    attachImage
  } = controller
  const [manualMaskByHandle, setManualMaskByHandle] = useState<ReadonlyMap<string, boolean>>(
    () => new Map()
  )
  const maskScopeKey = activeHandle ?? '__default__'
  const autoDetectedPrompt = Boolean(
    activeHandle && controller.terminalPasswordPromptHandles?.has(activeHandle)
  )
  const rawManualOverride = manualMaskByHandle.get(maskScopeKey)
  const manualOverride = reconcileTerminalManualMaskOverride({
    autoDetectedPrompt,
    manualOverride: rawManualOverride
  })
  if (manualOverride !== rawManualOverride) {
    setManualMaskByHandle((prev) => {
      const next = new Map(prev)
      next.delete(maskScopeKey)
      return next
    })
  }
  const inputMasked = resolveTerminalInputMaskedState({
    autoDetectedPrompt,
    manualOverride
  })
  const toggleInputMask = () => {
    setManualMaskByHandle((prev) => {
      const next = new Map(prev)
      const nextMasked = !inputMasked
      if (!autoDetectedPrompt && !nextMasked) {
        next.delete(maskScopeKey)
      } else {
        next.set(maskScopeKey, nextMasked)
      }
      return next
    })
  }
  if (!sessionCommandDockShown(controller)) {
    return null
  }
  return (
    <View
      style={[
        dockStyles.dock,
        { paddingBottom: insets.bottom, transform: [{ translateY: -keyboardLift }] }
      ]}
    >
      {rail.keysInRail ? (
        <MobileTerminalMoreKeysSheet
          controller={controller}
          visible={rail.moreKeysVisible}
          onClose={rail.closeMoreKeys}
        />
      ) : (
        <MobileSessionAccessoryKeys controller={controller} />
      )}
      <View style={dockStyles.inputBar}>
        <LiveInputField
          controller={controller}
          keysInRail={rail.keysInRail}
          inputMasked={inputMasked}
          onToggleMask={toggleInputMask}
          trailing={
            <MobileTerminalLiveInputStatus
              dictation={dictation}
              dictationMode={dictationMode}
              heard={liveDictationText}
              isAttaching={isAttaching}
            />
          }
        />
        <MobileTerminalInputActions
          canSend={canSend}
          isAttaching={isAttaching}
          dictation={dictation}
          dictationMode={dictationMode}
          dictationEnabled={dictationEnabled}
          buttonStyle={inputStyles.controlButton}
          activeButtonStyle={styles.dictationButtonActive}
          disabledButtonStyle={inputStyles.disabled}
          onAttachImage={() => void attachImage('library')}
          onAttachFile={() => void attachImage('files')}
          onDictationToggle={handleDictationToggle}
          onDictationPressIn={handleDictationPressIn}
          onDictationPressOut={handleDictationPressOut}
          onDictationCancel={cancelDictation}
        />
      </View>
    </View>
  )
}

// Only this field reads the typed text, so a keystroke re-renders it and not the dock or session.
function LiveInputField({
  controller,
  keysInRail,
  inputMasked,
  onToggleMask,
  trailing
}: {
  controller: MobileSessionController
  keysInRail: boolean
  inputMasked: boolean
  onToggleMask: () => void
  trailing: ReactNode
}) {
  const t = useMobileTranslation()
  const {
    liveInputCapture,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    bindLiveInputField,
    liveInputRef,
    submitLiveInput,
    canSend,
    dockKeys
  } = controller
  const text = useLiveInputCaptureText(liveInputCapture)
  const showMaskOverlay = inputMasked && text.length > 0
  return (
    <TextField
      inputRef={bindLiveInputField}
      monospace
      hiddenText={showMaskOverlay}
      inputOverlay={
        showMaskOverlay ? (
          <MobileTerminalPasswordMaskOverlay value={text} masked={inputMasked} />
        ) : undefined
      }
      style={dockStyles.liveField}
      leading={
        <MobileTerminalPasswordMaskToggle masked={inputMasked} onToggleMask={onToggleMask} />
      }
      label={t('session.terminalLiveInputStatus.liveInput', 'Live input')}
      trailing={trailing}
      value={text}
      onChange={(event) => {
        // A ctrl/alt/shift held on the Duo rail turns the next typed letter into a combo, while the rail shows it.
        if (
          !keysInRail ||
          !dockKeys.interceptTypedCharacter(text, event.nativeEvent.text, liveInputRef)
        ) {
          handleLiveInputChange(event)
        }
      }}
      onKeyPress={handleLiveInputKeyPress}
      onSubmitEditing={submitLiveInput}
      placeholder={t('session.commandDock.tapToShowKeyboard', 'Tap to show keyboard')}
      accessibilityLabel={t('session.commandDock.liveInputLabel', 'Live terminal input')}
      accessibilityHint={t(
        'session.commandDock.liveInputHint',
        'Typed text is sent directly to the active terminal'
      )}
      showSoftInputOnFocus
      secureTextEntry={inputMasked}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      smartInsertDelete={false}
      // Why: iOS textContentType overrides autoComplete and can narrow the keyboard; keep IME switching available.
      autoComplete="off"
      // Why: ASCII-only keyboard types hide non-Latin IMEs.
      keyboardType="default"
      returnKeyType="default"
      blurOnSubmit={false}
      editable={canSend}
      importantForAutofill="no"
    />
  )
}
