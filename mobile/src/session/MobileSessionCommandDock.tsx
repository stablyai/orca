import { View } from 'react-native'
import { Keyboard as KeyboardIcon } from 'lucide-react-native'
import { composerInputStyles as inputStyles } from '../components/composer-input/composer-input-styles'
import { TextField } from '../components/composer-input/TextField'
import { MobileTerminalLiveInputStatus } from './MobileTerminalLiveInputStatus'
import { MobileTerminalInputActions } from './MobileTerminalInputActions'
import { MobileSessionAccessoryKeys } from './MobileSessionAccessoryKeys'
import { MobileTerminalMoreKeysSheet } from './MobileTerminalMoreKeysSheet'
import { sessionCommandDockShown } from './mobile-session-command-dock-shown'
import { useSessionTerminalKeyRail } from './use-session-terminal-key-rail'
import { terminalDockStyles as dockStyles } from './terminal-dock-styles'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'

// The key row above one live field: every letter typed goes straight to the terminal, shell or agent.
export function MobileSessionCommandDock({ controller }: { controller: MobileSessionController }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const rail = useSessionTerminalKeyRail(controller)
  const {
    liveInputCapture,
    dictationMode,
    dictationEnabled,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    bindLiveInputField,
    liveInputRef,
    submitLiveInput,
    canSend,
    dictation,
    liveDictationText,
    dockKeys,
    cancelDictation,
    handleDictationToggle,
    handleDictationPressIn,
    handleDictationPressOut,
    isAttaching,
    attachImage,
    keyboardLift,
    dockBottomInset
  } = controller
  if (!sessionCommandDockShown(controller)) {
    return null
  }
  return (
    <View
      style={[
        dockStyles.dock,
        { paddingBottom: dockBottomInset, transform: [{ translateY: -keyboardLift }] }
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
        <TextField
          inputRef={bindLiveInputField}
          monospace
          style={dockStyles.liveField}
          leading={<KeyboardIcon size={17} color={colors.textSecondary} strokeWidth={2} />}
          label={t('session.terminalLiveInputStatus.liveInput', 'Live input')}
          trailing={
            <MobileTerminalLiveInputStatus
              dictation={dictation}
              dictationMode={dictationMode}
              heard={liveDictationText}
              isAttaching={isAttaching}
            />
          }
          value={liveInputCapture}
          onChange={(event) => {
            // A ctrl/alt/shift held on the Duo rail turns the next typed letter into a combo, while the rail shows it.
            if (
              !rail.keysInRail ||
              !dockKeys.interceptTypedCharacter(
                liveInputCapture,
                event.nativeEvent.text,
                liveInputRef
              )
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
