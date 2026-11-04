import { useCallback, useLayoutEffect } from 'react'
import { View, type TextInput } from 'react-native'
import { tuiAgentDisplayName } from '../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { hostOs } from '../platform/host-os'
import { ComposerSendButton } from '../components/composer-input/ComposerSendButton'
import { MessageBox } from '../components/composer-input/MessageBox'
import { composerInputStyles as inputStyles } from '../components/composer-input/composer-input-styles'
import { TextField } from '../components/composer-input/TextField'
import {
  getTerminalCommandKeyboardType,
  getTerminalLiveInputKeyboardType
} from '../terminal/terminal-keyboard-type'
import { MobileTerminalLiveInputStatus } from './MobileTerminalLiveInputStatus'
import { MobileTerminalCommandDictationPreview } from './MobileTerminalCommandDictationPreview'
import { readMobileDictationAnchor } from '../dictation/mobile-dictation-text-insertion'
import {
  MobileTerminalAttachButton,
  MobileTerminalDictationButton,
  MobileTerminalInputActions
} from './MobileTerminalInputActions'
import { MobileNativeChatStopButton } from './native-chat/input/MobileNativeChatStopButton'
import { MobileSessionAccessoryKeys } from './MobileSessionAccessoryKeys'
import { MobileTerminalMoreKeysSheet } from './MobileTerminalMoreKeysSheet'
import { sessionCommandDockShown } from './mobile-session-command-dock-shown'
import { useMobileCommandInputField } from './use-mobile-command-input-field'
import { useSessionTerminalKeyRail } from './use-session-terminal-key-rail'
import {
  isMobileTerminalTabRunningAgent,
  resolveMobileTerminalTabOwnedAgentId
} from './mobile-terminal-tab-agent'
import { terminalDockStyles as dockStyles } from './terminal-dock-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'

const ESC = '\x1b'

// Both fields stay mounted so a mode switch can move focus before the keyboard drops.
const inactiveFieldStyle = { position: 'absolute', left: 0, right: 0, opacity: 0 } as const

// Keys mode types straight into the terminal; Message mode writes in the chat composer and sends on tap.
// Return inserts a newline; the send button submits the whole buffer.
// Agent tabs open in Message, shells in Keys; the key row sends to the terminal in both.
export function MobileSessionCommandDock({ controller }: { controller: MobileSessionController }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const rail = useSessionTerminalKeyRail(controller)
  const {
    insets,
    bufferedTerminalDraftState,
    autocompleteEnabled,
    liveInputCapture,
    dictationMode,
    dictationEnabled,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    bindLiveInputField,
    liveInputRef,
    commandInputRef,
    submitLiveInput,
    canSend,
    canCompose,
    liveInputEnabled,
    dictation,
    commandDictationPreview,
    liveDictationText,
    commandFieldAnchorRef,
    activeHandle,
    activeSessionTab,
    dockKeys,
    handleAccessoryKey,
    cancelDictation,
    handleDictationToggle,
    handleDictationPressIn,
    handleDictationPressOut,
    handleSend,
    isAttaching,
    attachImage,
    keyboardLift
  } = controller
  const draft = bufferedTerminalDraftState.input
  const dockShown = sessionCommandDockShown(controller)
  // MessageBox owns the ref object. Android still needs the node so keyboard-hide can blur it.
  const bindCommandField = useCallback(
    (node: TextInput | null) => {
      if (node !== null) {
        commandInputRef.current = node
      }
    },
    [commandInputRef]
  )
  const { commandFieldRef, emptyResetEpoch, onCommandFieldFocus, onCommandFieldBlur } =
    useMobileCommandInputField({
      bindCommandField,
      input: draft
    })
  useLayoutEffect(() => {
    if (hostOs() !== 'android') {
      return
    }
    commandFieldRef(dockShown ? commandInputRef.current : null)
  }, [autocompleteEnabled, commandFieldRef, commandInputRef, dockShown, emptyResetEpoch])
  if (!dockShown) {
    return null
  }
  const terminalTab = activeSessionTab?.type === 'terminal' ? activeSessionTab : null
  const runsAgent = terminalTab !== null && isMobileTerminalTabRunningAgent(terminalTab)
  const agentId =
    terminalTab && runsAgent ? resolveMobileTerminalTabOwnedAgentId(terminalTab) : null
  const agentName = agentId ? tuiAgentDisplayName(agentId) : null
  const showStop =
    runsAgent && terminalTab?.agentStatus?.state === 'working' && draft.trim().length === 0
  const attachProps = {
    canSend,
    isAttaching,
    onAttachImage: () => void attachImage('library'),
    onAttachFile: () => void attachImage('files')
  }
  const dictationProps = {
    canSend,
    dictation,
    dictationMode,
    dictationEnabled,
    activeButtonStyle: styles.dictationButtonActive,
    onDictationToggle: handleDictationToggle,
    onDictationPressIn: handleDictationPressIn,
    onDictationPressOut: handleDictationPressOut,
    onDictationCancel: cancelDictation
  }
  return (
    <View
      style={[
        dockStyles.dock,
        { paddingBottom: insets.bottom, transform: [{ translateY: -keyboardLift }] }
      ]}
    >
      <View>
        <View
          style={[dockStyles.keysBar, !liveInputEnabled && inactiveFieldStyle]}
          pointerEvents={liveInputEnabled ? 'auto' : 'none'}
          aria-hidden={!liveInputEnabled}
          accessibilityElementsHidden={!liveInputEnabled}
          importantForAccessibility={liveInputEnabled ? 'auto' : 'no-hide-descendants'}
        >
          <TextField
            inputRef={bindLiveInputField}
            monospace
            style={dockStyles.liveField}
            trailing={
              liveInputEnabled ? (
                <MobileTerminalLiveInputStatus
                  dictation={dictation}
                  dictationMode={dictationMode}
                  heard={liveDictationText}
                  isAttaching={isAttaching}
                />
              ) : undefined
            }
            value={liveInputCapture}
            onChange={(event) => {
              if (
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
            placeholder={t('session.terminalLiveInputStatus.liveInput', 'Live input')}
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
          <MobileTerminalInputActions
            {...attachProps}
            {...dictationProps}
            buttonStyle={inputStyles.ghostButton}
            disabledButtonStyle={inputStyles.disabled}
          />
        </View>
        <View
          style={liveInputEnabled && inactiveFieldStyle}
          pointerEvents={liveInputEnabled ? 'none' : 'auto'}
          aria-hidden={liveInputEnabled}
          accessibilityElementsHidden={liveInputEnabled}
          importantForAccessibility={liveInputEnabled ? 'no-hide-descendants' : 'auto'}
        >
          <MessageBox
            // Why: Android caches IME inputType at mount, so toggling autocomplete must remount there;
            // cycling emptyResetEpoch on text clear tears down a lingering ActionMode.
            key={
              hostOs() === 'android'
                ? `message-${emptyResetEpoch}-${autocompleteEnabled ? 'ac-on' : 'ac-off'}`
                : 'message'
            }
            inputRef={commandInputRef}
            monospace={!runsAgent}
            style={dockStyles.composer}
            value={draft}
            // Why: iOS kills active dictation/IME if JS writes a value differing from native text; store raw, normalize at send.
            onChangeText={(text) => {
              if (!dockKeys.interceptTypedCharacter(draft, text, commandInputRef)) {
                bufferedTerminalDraftState.setInput(text)
              }
            }}
            onSelectionChange={(e) => {
              commandFieldAnchorRef.current = {
                handle: activeHandle,
                anchor: readMobileDictationAnchor(e, draft)
              }
            }}
            inputOverlay={
              !liveInputEnabled && commandDictationPreview ? (
                <MobileTerminalCommandDictationPreview
                  draft={draft}
                  preview={commandDictationPreview}
                  monospace={!runsAgent}
                />
              ) : undefined
            }
            // The preview stands in for an empty draft, so its placeholder must not show through.
            placeholder={
              commandDictationPreview
                ? undefined
                : runsAgent
                  ? t('session.commandDock.messageAgentPlaceholder', 'Message {{agent}}', {
                      agent: agentName ?? t('session.commandDock.theAgent', 'the agent')
                    })
                  : t('session.commandDock.writeCommandPlaceholder', 'Write a command, then send')
            }
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
            submitBehavior="newline"
            blurOnSubmit={false}
            // Why: composing is local — an outage must not lock the field or discard typed text (#6713).
            editable={canCompose}
            tabIndex={liveInputEnabled ? -1 : 0}
            onSubmitEditing={() => void handleSend()}
            onFocus={onCommandFieldFocus}
            onBlur={onCommandFieldBlur}
            leading={
              <MobileTerminalAttachButton
                {...attachProps}
                buttonStyle={inputStyles.controlButton}
                disabledButtonStyle={inputStyles.disabled}
              />
            }
            trailing={
              <>
                <MobileTerminalDictationButton
                  {...dictationProps}
                  meterHalo={dictation.meter}
                  buttonStyle={inputStyles.ghostButton}
                  disabledButtonStyle={inputStyles.disabled}
                />
                {showStop ? (
                  <MobileNativeChatStopButton
                    held={false}
                    onStop={() => void handleAccessoryKey({ bytes: ESC })}
                  />
                ) : (
                  <ComposerSendButton
                    onPress={() => void handleSend()}
                    canSend={canSend && draft.trim().length > 0}
                    label={t('session.commandDock.sendCommand', 'Send command')}
                  />
                )}
              </>
            }
          />
        </View>
      </View>
      {rail.keysInRail ? (
        <MobileTerminalMoreKeysSheet
          controller={controller}
          visible={rail.moreKeysVisible}
          onClose={rail.closeMoreKeys}
        />
      ) : (
        <MobileSessionAccessoryKeys controller={controller} />
      )}
    </View>
  )
}
