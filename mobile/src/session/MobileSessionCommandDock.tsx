import { View, TextInput } from 'react-native'
import { tuiAgentDisplayName } from '../../../src/shared/tui-agent-display-names'
import { hostOs } from '../platform/host-os'
import { ComposerSendButton } from '../components/composer-input/ComposerSendButton'
import { MessageBox } from '../components/composer-input/MessageBox'
import { composerInputStyles as inputStyles } from '../components/composer-input/composer-input-styles'
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
import { useSessionTerminalKeyRail } from './use-session-terminal-key-rail'
import {
  isMobileTerminalTabRunningAgent,
  resolveMobileTerminalTabOwnedAgentId
} from './mobile-terminal-tab-agent'
import { terminalDockStyles as dockStyles } from './terminal-dock-styles'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'

const ESC = '\x1b'

// Both fields must remain focusable during the tap that hands the keyboard to the other mode.
const inactiveFieldStyle = { position: 'absolute', left: 0, right: 0, opacity: 0 } as const

// Keys mode types straight into the terminal; Message mode writes in the chat composer and sends on tap.
// Agent tabs open in Message, shells in Keys; the key row sends to the terminal in both.
export function MobileSessionCommandDock({ controller }: { controller: MobileSessionController }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const rail = useSessionTerminalKeyRail(controller)
  const {
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
    keyboardLift,
    dockBottomInset
  } = controller
  if (!sessionCommandDockShown(controller)) {
    return null
  }
  const terminalTab = activeSessionTab?.type === 'terminal' ? activeSessionTab : null
  const runsAgent = terminalTab !== null && isMobileTerminalTabRunningAgent(terminalTab)
  const agentId =
    terminalTab && runsAgent ? resolveMobileTerminalTabOwnedAgentId(terminalTab) : null
  const agentName = agentId ? tuiAgentDisplayName(agentId) : null
  const draft = bufferedTerminalDraftState.input
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
        { paddingBottom: dockBottomInset, transform: [{ translateY: -keyboardLift }] }
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
          <View style={[inputStyles.field, dockStyles.liveField]}>
            <TextInput
              ref={bindLiveInputField}
              style={[
                inputStyles.fieldText,
                inputStyles.mono,
                !canSend && styles.liveInputCaptureDisabled
              ]}
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
            // Why: Android caches IME inputType at mount, so toggling autocomplete must remount there; iOS updates in place.
            key={hostOs() === 'android' ? `message-ac-${autocompleteEnabled}` : 'message'}
            inputRef={commandInputRef}
            docked
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
            // Why: not autofill content, but keyboard must stay default so non-Latin IMEs remain selectable.
            autoComplete="off"
            keyboardType={getTerminalCommandKeyboardType(hostOs(), autocompleteEnabled)}
            // Why: composing is local — an outage must not lock the field or discard typed text (#6713).
            editable={canCompose}
            tabIndex={liveInputEnabled ? -1 : 0}
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
