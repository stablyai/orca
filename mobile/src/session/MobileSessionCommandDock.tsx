import { useContext, useEffect, useRef, type ReactNode } from 'react'
import { Platform, View, type HostInstance } from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'
import { composerInputStyles as inputStyles } from '../components/composer-input/composer-input-styles'
import { TextField } from '../components/composer-input/TextField'
import { MobileTerminalLiveInputStatus } from '../terminal/session/input-controls/MobileTerminalLiveInputStatus'
import {
  MobileTerminalInputActions,
  MobileTerminalLeadingButton
} from '../terminal/session/input-controls/MobileTerminalInputActions'
import { MobileSessionAccessoryKeys } from '../terminal/session/accessory-keys/MobileSessionAccessoryKeys'
import { MobileTerminalMoreKeysSheet } from '../terminal/session/accessory-keys/MobileTerminalMoreKeysSheet'
import { sessionCommandDockShown } from './mobile-session-command-dock-shown'
import { useSessionTerminalKeyRail } from '../terminal/session/accessory-keys/use-session-terminal-key-rail'
import { terminalDockStyles as dockStyles } from '../terminal/session/accessory-keys/terminal-dock-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { SHEET_CURVE } from '../components/motion/sheet-motion-values'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileSessionController } from './use-mobile-session-controller'
import { useMobileSessionKeyboardLift } from '../terminal/session/input-controls/use-mobile-session-keyboard-lift'
import { useLiveInputCaptureText } from '../terminal/session/input-controls/live-input-capture'
import { useKeyboardPersistingTaps } from '../platform/keyboard/keyboard-persisting-taps'
import { MobileDictationLiveContext } from '../dictation/mobile-dictation-live-context'

// Native iOS reports the lift as the keyboard starts its 250 ms move; Android and the page (even on an iPhone) report it once it has landed.
const IOS_KEYBOARD_MOTION_MS = 250

// The key row above one live field: every letter typed goes straight to the terminal, shell or agent.
export function MobileSessionCommandDock({ controller }: { controller: MobileSessionController }) {
  useMobileColorScheme()
  const rail = useSessionTerminalKeyRail(controller)
  const live = useContext(MobileDictationLiveContext)
  const keyboardLift = useMobileSessionKeyboardLift(controller.dockBottomInset)
  // Ride the keyboard's curve instead of jumping to where it will stop.
  const lift = useSharedValue(keyboardLift)
  useEffect(() => {
    lift.value = withTiming(keyboardLift, {
      duration: Platform.OS === 'ios' ? IOS_KEYBOARD_MOTION_MS : 0,
      easing: Easing.bezier(...SHEET_CURVE)
    })
  }, [keyboardLift, lift])
  // The page build has no worklet plugin, so the style names what it reads.
  const liftStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -lift.value }] }), [lift])
  // The field's ✕, which the held mic may be released over.
  const dictationCancelRef = useRef<HostInstance>(null)
  // The mic and attach buttons keep the field focused, like the key row: a closing keyboard ends a held mic.
  const keepsKeyboard = useKeyboardPersistingTaps('always')
  const {
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
  if (!sessionCommandDockShown(controller)) {
    return null
  }
  return (
    <Animated.View style={[dockStyles.dock, { paddingBottom: insets.bottom }, liftStyle]}>
      <MobileTerminalMoreKeysSheet
        controller={controller}
        visible={rail.moreKeysVisible}
        besideRail={rail.keysInRail}
        onClose={rail.closeMoreKeys}
      />
      {rail.keysInRail ? null : (
        <MobileSessionAccessoryKeys controller={controller} onMoreKeys={rail.openMoreKeys} />
      )}
      <View ref={keepsKeyboard} style={dockStyles.inputBar}>
        <MobileTerminalLeadingButton
          canSend={canSend}
          isAttaching={isAttaching}
          keyboardUp={keyboardLift > 0}
          dictating={
            dictation.isStarting ||
            dictation.isRecording ||
            dictation.isProcessing ||
            live?.failureReason != null
          }
          buttonStyle={inputStyles.controlButton}
          disabledButtonStyle={inputStyles.disabled}
          onAttachImage={() => void attachImage('library')}
          onAttachFile={() => void attachImage('files')}
          onDismissKeyboard={controller.dismissSoftwareKeyboard}
        />
        <LiveInputField
          controller={controller}
          trailing={
            <MobileTerminalLiveInputStatus
              dictation={dictation}
              cancelRef={dictationCancelRef}
              dictationMode={dictationMode}
              heard={liveDictationText}
              isAttaching={isAttaching}
            />
          }
        />
        <MobileTerminalInputActions
          canSend={canSend}
          dictation={dictation}
          dictationMode={dictationMode}
          dictationEnabled={dictationEnabled}
          buttonStyle={inputStyles.controlButton}
          dictationCancelRef={dictationCancelRef}
          disabledButtonStyle={inputStyles.disabled}
          onDictationToggle={handleDictationToggle}
          onDictationPressIn={handleDictationPressIn}
          onDictationPressOut={handleDictationPressOut}
          onDictationCancel={cancelDictation}
        />
      </View>
    </Animated.View>
  )
}

// Only this field reads the typed text, so a keystroke re-renders it and not the dock or session.
function LiveInputField({
  controller,
  trailing
}: {
  controller: MobileSessionController
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
  return (
    <TextField
      inputRef={bindLiveInputField}
      monospace
      style={dockStyles.liveField}
      trailing={trailing}
      value={text}
      onChange={(event) => {
        // A held Shift, Ctrl or Alt on the key row or the Duo rail turns the next typed letter into a combo.
        if (!dockKeys.interceptTypedCharacter(text, event.nativeEvent.text, liveInputRef)) {
          handleLiveInputChange(event)
        }
      }}
      onKeyPress={handleLiveInputKeyPress}
      onSubmitEditing={submitLiveInput}
      placeholder={t('session.commandDock.typeIntoTerminal', 'Type into terminal')}
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
      // Why: ASCII-only keyboard types hide non-Latin IMEs.
      keyboardType="default"
      returnKeyType="default"
      blurOnSubmit={false}
      editable={canSend}
      importantForAutofill="no"
    />
  )
}
