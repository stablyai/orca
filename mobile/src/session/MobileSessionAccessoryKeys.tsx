import { useEffect, useRef, useState } from 'react'
import { View, Text, ScrollView, Pressable } from 'react-native'
import { ChevronDown, Ellipsis, Keyboard as KeyboardIcon, PenLine } from 'lucide-react-native'
import type { TerminalShortcutModifier } from '../terminal/terminal-accessory-keys'
import { TERMINAL_ACCESSORY_REPEAT_DELAY_MS } from '../terminal/terminal-accessory-repeat'
import { SPECIAL_KEY_LABELS } from '../terminal/terminal-key-definitions'
import { createTerminalLiveAccessoryInput } from '../terminal/terminal-live-accessory-input'
import { isTerminalPhoneDisplayMode } from './mobile-session-route-helpers'
import { isMobileTerminalTabRunningAgent } from './mobile-terminal-tab-agent'
import { TerminalArrowPad } from './TerminalArrowPad'
import { TerminalMoreKeysSheet } from './TerminalMoreKeysSheet'
import { terminalDockStyles as styles } from './terminal-dock-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useKeyboardPersistingTaps } from '../platform/keyboard-persisting-taps'
import type { StickyModifiers } from '../terminal/terminal-sticky-modifiers'
import { terminalDockKeyInput } from './use-terminal-dock-keys'
import type { MobileSessionController } from './use-mobile-session-controller'

const ESC = '\x1b'
const CTRL_C = '\x03'
const SHELL_CHARACTERS = ['/', '|', '~', '-', ':']
const AGENT_CHARACTERS = ['/', '@', '!']
const ARROW_IDS = ['arrowUp', 'arrowDown', 'arrowLeft', 'arrowRight']
// Built-in keys each row already shows; the ⋯ sheet offers the rest.
const SHELL_ROW_KEY_IDS: ReadonlySet<string> = new Set(['escape', 'tab', ...ARROW_IDS])
const AGENT_ROW_KEY_IDS: ReadonlySet<string> = new Set([
  'escape',
  'shiftTab',
  'enter',
  'ctrlC',
  ...ARROW_IDS
])

// The terminal's key row: a row under the input, or a column in the Duo's side rail. Every key goes straight to the terminal.
export function MobileSessionAccessoryKeys({
  controller,
  vertical = false
}: {
  controller: MobileSessionController
  vertical?: boolean
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const {
    activeHandle,
    activeSessionTab,
    customKeys,
    setShowCustomKeyModal,
    setDeleteKeyTarget,
    visibleBuiltInAccessoryKeys,
    terminalModes,
    canPaste,
    canSend,
    canCompose,
    liveInputEnabled,
    isAttaching,
    attachImage,
    toggleDisplayMode,
    handleAccessoryKey,
    dockKeys: keys,
    dismissSoftwareKeyboard,
    liveInputRef,
    commandInputRef,
    toggleLiveInput,
    stopAccessoryRepeat,
    cancelAccessoryRepeat,
    prepareAccessoryPress,
    handlePaste,
    keyboardLift
  } = controller
  const keepsKeyboard = useKeyboardPersistingTaps('always')
  const [padHeld, setPadHeld] = useState(false)
  const [sheetVisible, setSheetVisible] = useState(false)
  const padPressRef = useRef<{
    modifiers: StickyModifiers
    tap: (() => Promise<boolean>) | null
  } | null>(null)
  // An unmounting row never sees a held arrow lift.
  useEffect(() => cancelAccessoryRepeat, [cancelAccessoryRepeat])

  const runsAgent =
    activeSessionTab?.type === 'terminal' && isMobileTerminalTabRunningAgent(activeSessionTab)
  const keyboardUp = keyboardLift > 0
  const keyStyle = vertical ? [styles.key, styles.keyVertical] : styles.key
  const sendBytes = (bytes: string) => void handleAccessoryKey({ bytes })

  const keyButton = (
    id: string,
    label: string,
    accessibilityLabel: string,
    onPress: () => void
  ): React.JSX.Element => (
    <Pressable
      key={id}
      style={({ pressed }) => [keyStyle, pressed && styles.keyPressed, !canSend && styles.disabled]}
      disabled={!canSend}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <Text style={styles.keyText}>{label}</Text>
    </Pressable>
  )
  const sendKeyLabel = (label: string) =>
    t('session.accessoryKeys.sendKey', 'Send {{label}}', { label })
  const specialKey = (id: string, label: string, name: string) =>
    keyButton(id, label, sendKeyLabel(name), () => keys.sendKey(id))
  const modifierKey = (modifier: TerminalShortcutModifier, label: string, name: string) => {
    const latch = keys.modifiers[modifier]
    return (
      <Pressable
        key={modifier}
        style={({ pressed }) => [
          keyStyle,
          latch === 'once' && styles.keyOnce,
          latch === 'locked' && styles.keyLocked,
          pressed && styles.keyPressed,
          !canSend && styles.disabled
        ]}
        disabled={!canSend}
        onPress={() => keys.tapModifier(modifier)}
        accessibilityRole="button"
        accessibilityLabel={name}
        accessibilityHint={t(
          'session.accessoryKeys.modifierHint',
          'Applies to the next key. Double tap to keep it on.'
        )}
        accessibilityState={{ selected: latch !== 'off' }}
      >
        <Text
          style={[
            styles.keyText,
            latch === 'once' && styles.keyOnceText,
            latch === 'locked' && styles.keyLockedText
          ]}
        >
          {label}
        </Text>
      </Pressable>
    )
  }
  const characterKeys = (characters: readonly string[]) =>
    characters.map((character) =>
      keyButton(
        `char-${character}`,
        character,
        t('session.accessoryKeys.typeCharacter', 'Type {{character}}', { character }),
        () => keys.sendKey(character)
      )
    )
  const arrowPad = (
    <TerminalArrowPad
      key="arrows"
      disabled={!canSend}
      // Prepared on touch-down, so a lift after a terminal switch can't land on the new terminal.
      onPressStart={(side) => {
        const modifiers = keys.takeModifiers()
        const input = terminalDockKeyInput(side, modifiers)
        padPressRef.current = {
          modifiers,
          tap: input ? prepareAccessoryPress(input).tap : null
        }
      }}
      onTap={() => {
        void padPressRef.current?.tap?.()
        padPressRef.current = null
      }}
      onRepeatStart={(arrow) => {
        const input = terminalDockKeyInput(arrow, padPressRef.current?.modifiers ?? keys.modifiers)
        if (input) {
          prepareAccessoryPress(input).hold(TERMINAL_ACCESSORY_REPEAT_DELAY_MS)
        }
      }}
      onRepeatStop={() => {
        padPressRef.current = null
        stopAccessoryRepeat()
      }}
      onAccessibilityArrow={keys.sendKey}
      onHoldChange={setPadHeld}
    />
  )
  const ctrlKey = modifierKey('ctrl', 'ctrl', t('session.accessoryKeys.control', 'Control'))
  const rowKeys = runsAgent
    ? [
        specialKey('escape', 'esc', t('session.accessoryKeys.escape', 'Escape')),
        keyButton(
          'shiftTab',
          '⇧tab',
          sendKeyLabel(t('session.accessoryKeys.shiftTab', 'Shift Tab')),
          () => sendBytes(`${ESC}[Z`)
        ),
        arrowPad,
        specialKey('enter', '⏎', t('session.accessoryKeys.enter', 'Enter')),
        keyButton('ctrlC', '^C', t('session.accessoryKeys.interrupt', 'Interrupt terminal'), () =>
          sendBytes(CTRL_C)
        ),
        ctrlKey,
        ...characterKeys(AGENT_CHARACTERS)
      ]
    : [
        specialKey('escape', 'esc', t('session.accessoryKeys.escape', 'Escape')),
        ctrlKey,
        specialKey('tab', 'tab', t('session.accessoryKeys.tab', 'Tab')),
        arrowPad,
        modifierKey('alt', 'alt', t('session.accessoryKeys.alt', 'Alt')),
        modifierKey('shift', '⇧', t('session.accessoryKeys.shift', 'Shift')),
        ...characterKeys(SHELL_CHARACTERS)
      ]

  const showKeyboard = () => (liveInputEnabled ? liveInputRef : commandInputRef).current?.focus()

  return (
    <View ref={keepsKeyboard} style={vertical ? styles.keyRail : styles.keyRow}>
      <Pressable
        style={({ pressed }) => [
          styles.modeKey,
          vertical && styles.keyVertical,
          pressed && styles.keyPressed,
          !canCompose && styles.disabled
        ]}
        // Offline, Keys mode is dead but the composer still composes; keep the escape hatch tappable (#6713).
        disabled={!canCompose}
        onPress={toggleLiveInput}
        accessibilityRole="button"
        accessibilityLabel={
          liveInputEnabled
            ? t(
                'session.accessoryKeys.keysModeLabel',
                'Keys mode: typing goes straight to the terminal. Switch to Message mode'
              )
            : t(
                'session.accessoryKeys.messageModeLabel',
                'Message mode: write, then send. Switch to Keys mode'
              )
        }
      >
        {liveInputEnabled ? (
          <KeyboardIcon size={15} color={colors.textPrimary} strokeWidth={2} />
        ) : (
          <PenLine size={15} color={colors.textPrimary} strokeWidth={2} />
        )}
        <Text style={styles.modeKeyText}>
          {liveInputEnabled
            ? t('session.accessoryKeys.keysMode', 'Keys')
            : t('session.accessoryKeys.messageMode', 'Message')}
        </Text>
      </Pressable>
      {/* Why: default tap handling makes the first key tap dismiss the keyboard and get swallowed (#5106). */}
      <ScrollView
        style={vertical ? styles.keyScrollVertical : styles.keyScroll}
        horizontal={!vertical}
        scrollEnabled={!padHeld}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={vertical ? styles.keyScrollContentVertical : styles.keyScrollContent}
        keyboardShouldPersistTaps="always"
        onScrollBeginDrag={cancelAccessoryRepeat}
      >
        {rowKeys}
        <Pressable
          style={({ pressed }) => [
            styles.ghostKey,
            vertical && styles.keyVertical,
            pressed && styles.keyPressed
          ]}
          onPress={() => setSheetVisible(true)}
          accessibilityRole="button"
          accessibilityLabel={t('session.accessoryKeys.moreKeys', 'More keys and actions')}
        >
          <Ellipsis size={18} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
      </ScrollView>
      {/* Why: fixed keyboard escape hatch outside the scroll view, so it can't scroll away (#5106). */}
      <Pressable
        style={({ pressed }) => [
          styles.iconKey,
          vertical && styles.keyVertical,
          pressed && styles.keyPressed,
          !keyboardUp && !canCompose && styles.disabled
        ]}
        disabled={!keyboardUp && !canCompose}
        onPress={keyboardUp ? dismissSoftwareKeyboard : showKeyboard}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={
          keyboardUp
            ? t('session.accessoryKeys.dismissKeyboard', 'Dismiss keyboard')
            : t('session.accessoryKeys.showKeyboard', 'Show keyboard')
        }
      >
        {keyboardUp ? (
          <ChevronDown size={18} color={colors.textSecondary} strokeWidth={2.2} />
        ) : (
          <KeyboardIcon size={17} color={colors.textSecondary} strokeWidth={2} />
        )}
      </Pressable>
      <TerminalMoreKeysSheet
        visible={sheetVisible}
        onClose={() => setSheetVisible(false)}
        canSend={canSend}
        canPaste={canPaste}
        isAttaching={isAttaching}
        phoneDisplay={isTerminalPhoneDisplayMode(activeHandle, terminalModes)}
        rowKeyIds={runsAgent ? AGENT_ROW_KEY_IDS : SHELL_ROW_KEY_IDS}
        builtInKeys={visibleBuiltInAccessoryKeys}
        customKeys={customKeys}
        onPaste={() => void handlePaste()}
        onAttachImage={() => void attachImage('library')}
        onAttachFile={() => void attachImage('files')}
        onToggleDisplay={() => {
          if (activeHandle) {
            void toggleDisplayMode(activeHandle)
          }
        }}
        onBuiltInKey={(key) =>
          SPECIAL_KEY_LABELS[key.id]
            ? keys.sendKey(key.id)
            : void handleAccessoryKey(createTerminalLiveAccessoryInput(key))
        }
        onSpecialKey={keys.sendKey}
        onCustomKey={(key) => sendBytes(key.bytes)}
        onDeleteCustomKey={setDeleteKeyTarget}
        onAddCustomKey={() => setShowCustomKeyModal(true)}
      />
    </View>
  )
}
