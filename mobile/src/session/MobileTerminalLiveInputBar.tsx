import { Pressable, TextInput, Platform } from 'react-native'
import { Keyboard as KeyboardIcon } from 'lucide-react-native'
import { HardwareKeyboardCaptureView } from '@orca/expo-hardware-keyboard'
import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { getTerminalLiveInputKeyboardType } from '../terminal/terminal-keyboard-type'
import { MobileTerminalLiveInputStatus } from './MobileTerminalLiveInputStatus'
import { MobileTerminalInputActions } from './MobileTerminalInputActions'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'

export function MobileTerminalLiveInputBar({
  controller,
  hardwareInputFocus
}: {
  controller: MobileSessionController
  hardwareInputFocus: { handleTouchStart: () => void; showSoftInputOnFocus: boolean }
}) {
  const [routeFocused, setRouteFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setRouteFocused(true)
      return () => setRouteFocused(false)
    }, [])
  )
  const {
    handleLiveInputHardwareKey,
    canSend,
    focusLiveInput,
    dictation,
    isAttaching,
    liveInputCapture,
    dictationMode,
    attachImage,
    handleDictationToggle,
    handleDictationPressIn,
    handleDictationPressOut,
    cancelDictation,
    liveInputRef,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    handleLiveInputSubmit,
    activeSessionTab,
    getSendCompletionGeneration,
    getLiveInteractionGeneration,
    dismissKeyboardAfterAgentSend
  } = controller
  return (
    <HardwareKeyboardCaptureView
      style={[styles.inputBar, styles.liveInputBar]}
      enabled={canSend && routeFocused}
      onHardwareKey={({ nativeEvent }) => {
        if (canSend && routeFocused) {
          handleLiveInputHardwareKey(nativeEvent)
        }
      }}
    >
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
        onTouchStart={hardwareInputFocus.handleTouchStart}
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
        showSoftInputOnFocus={hardwareInputFocus.showSoftInputOnFocus}
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
    </HardwareKeyboardCaptureView>
  )
}
