import { useMemo, useRef } from 'react'
import { Pressable, ScrollView, Text, View, type ScrollViewInstance } from 'react-native'
import {
  ChevronDown,
  ChevronUp,
  Keyboard as KeyboardIcon,
  Monitor,
  Plus,
  Smartphone
} from 'lucide-react-native'
import { triggerMediumImpact } from '../../../platform/haptics/haptics'
import { TERMINAL_ACCESSORY_REPEAT_DELAY_MS } from '../../key-input/terminal-accessory-repeat'
import type { TerminalAccessoryKey } from '../../key-input/terminal-accessory-keys'
import type { CustomKey } from '../../key-input/terminal-custom-keys'
import type {
  AgentSmartKey,
  AgentSmartKeySet
} from '../../../../../src/shared/terminal/input/agent-smart-keys'
import type { MobileSessionController } from '../../../session/use-mobile-session-controller'
import { styles as sessionStyles } from '../../../session/mobile-session-styles'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { MobileSessionLatchKeys } from './MobileSessionLatchKeys'
import { MobileSessionSmartKeys } from './MobileSessionSmartKeys'
import { TERMINAL_KEY_HIT_SLOP, terminalDockStyles as styles } from './terminal-dock-styles'
import { isAccessibilityClick, useTerminalKeyRowTouch } from './use-terminal-key-row-touch'

type PreparedPress = ReturnType<MobileSessionController['prepareAccessoryPress']>

type Props = {
  rowKeys: TerminalAccessoryKey[]
  isFirstRow: boolean
  isLastRow: boolean
  showKeyboardDismiss: boolean
  onDismissKeyboard: () => void
  canCollapseRows: boolean
  rowsCollapsed: boolean
  onToggleCollapseRows: () => void
  latestSmartKeys: AgentSmartKeySet | null
  canSend: boolean
  phoneDisplay: boolean
  hasActiveHandle: boolean
  onToggleDisplayMode: () => void
  canPaste: boolean
  onPaste: () => void
  modifiers: MobileSessionController['dockKeys']['modifiers']
  onTapModifier: MobileSessionController['dockKeys']['tapModifier']
  includeLatchKeys: boolean
  customKeys: CustomKey[]
  onPressCustomKey: (key: CustomKey) => void
  onDeleteCustomKey: (key: CustomKey) => void
  onAddCustomKey: () => void
  prepareBuiltInPress: (key: TerminalAccessoryKey) => PreparedPress
  stopAccessoryRepeat: () => void
  cancelAccessoryRepeat: () => void
  sendSmartKey: (key: AgentSmartKey) => void
}

/** Renders a single horizontally scrollable row of terminal shortcut keys. */
export function MobileSessionAccessoryKeyRow({
  rowKeys,
  isFirstRow,
  isLastRow,
  showKeyboardDismiss,
  onDismissKeyboard,
  canCollapseRows,
  rowsCollapsed,
  onToggleCollapseRows,
  latestSmartKeys,
  canSend,
  phoneDisplay,
  hasActiveHandle,
  onToggleDisplayMode,
  canPaste,
  onPaste,
  modifiers,
  onTapModifier,
  includeLatchKeys,
  customKeys,
  onPressCustomKey,
  onDeleteCustomKey,
  onAddCustomKey,
  prepareBuiltInPress,
  stopAccessoryRepeat,
  cancelAccessoryRepeat,
  sendSmartKey
}: Props): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const accessoryPresses = useRef(new Map<string, PreparedPress>())
  const scrollRef = useRef<ScrollViewInstance>(null)
  const touch = useTerminalKeyRowTouch({
    scrollRef,
    latest: isFirstRow ? latestSmartKeys : null,
    cancelAccessoryRepeat
  })
  const smartKeys = touch.shown

  const keyStyle = ({ pressed }: { pressed: boolean }) => [
    styles.key,
    pressed && styles.keyPressed,
    !canSend && styles.disabled
  ]
  const sendKeyLabel = (label: string) =>
    t('session.accessoryKeys.sendKey', 'Send {{label}}', { label })

  const latchIndex = useMemo(
    () => (includeLatchKeys ? rowKeys.findIndex((key) => key.id === 'tab') + 1 : -1),
    [includeLatchKeys, rowKeys]
  )

  const latchKeys = includeLatchKeys ? (
    <MobileSessionLatchKeys
      key="latches"
      modifiers={modifiers}
      disabled={!canSend}
      onPressIn={() => touch.arm('latch')}
      onPress={(modifier, event) => touch.fire('latch', event, () => onTapModifier(modifier))}
    />
  ) : null

  return (
    <View style={styles.keyRow} {...touch.rowTouchHandlers}>
      {/* Why: fixed keyboard escape hatch; outside the ScrollView so it can't scroll away (#5106). */}
      {isFirstRow && showKeyboardDismiss && (
        <Pressable
          style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          onPress={onDismissKeyboard}
          hitSlop={TERMINAL_KEY_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={t('session.accessoryKeys.dismissKeyboard', 'Dismiss keyboard')}
          accessibilityHint={t(
            'session.accessoryKeys.dismissKeyboardHint',
            'Hides the software keyboard and keeps the current terminal session open.'
          )}
        >
          <View style={sessionStyles.keyboardDismissGlyph}>
            <KeyboardIcon size={15} color={colors.textPrimary} strokeWidth={2} />
            <ChevronDown
              size={10}
              color={colors.textPrimary}
              strokeWidth={2.5}
              style={sessionStyles.keyboardDismissChevron}
            />
          </View>
        </Pressable>
      )}
      {/* Why: default tap handling makes the first key tap dismiss the keyboard and get swallowed (#5106). */}
      <ScrollView
        ref={scrollRef}
        style={styles.keyScroll}
        horizontal
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.keyScrollContent}
        keyboardShouldPersistTaps="always"
        onScroll={touch.onScroll}
        scrollEventThrottle={16}
      >
        {isFirstRow && smartKeys ? (
          <MobileSessionSmartKeys
            keySet={smartKeys}
            disabled={!canSend}
            onPressIn={(key) => touch.arm(`smart:${key.id}`)}
            onPress={(key, event) => touch.fire(`smart:${key.id}`, event, () => sendSmartKey(key))}
          />
        ) : null}
        {isFirstRow && (
          <Pressable
            style={keyStyle}
            disabled={!canSend}
            hitSlop={TERMINAL_KEY_HIT_SLOP}
            onPressIn={() => touch.arm('displayMode')}
            onPress={(event) =>
              touch.fire('displayMode', event, () => {
                if (hasActiveHandle) {
                  onToggleDisplayMode()
                }
              })
            }
            accessibilityRole="button"
            accessibilityLabel={
              phoneDisplay
                ? t('session.accessoryKeys.switchToDesktopMode', 'Switch to desktop mode')
                : t('session.accessoryKeys.switchToPhoneMode', 'Switch to phone mode')
            }
          >
            {phoneDisplay ? (
              <Monitor size={15} color={colors.textPrimary} strokeWidth={2} />
            ) : (
              <Smartphone size={15} color={colors.textPrimary} strokeWidth={2} />
            )}
          </Pressable>
        )}
        {isFirstRow && canPaste && (
          <Pressable
            style={keyStyle}
            disabled={!canSend}
            hitSlop={TERMINAL_KEY_HIT_SLOP}
            onPressIn={() => touch.arm('paste')}
            onPress={(event) => touch.fire('paste', event, onPaste)}
            accessibilityRole="button"
            accessibilityLabel={t(
              'session.accessoryKeys.pasteFromClipboard',
              'Paste from clipboard'
            )}
          >
            <Text style={styles.keyText}>{t('session.accessoryKeys.paste', 'Paste')}</Text>
          </Pressable>
        )}
        {latchIndex === 0 ? latchKeys : null}
        {rowKeys.flatMap((key, index) => [
          <Pressable
            key={key.id}
            style={keyStyle}
            disabled={!canSend}
            hitSlop={TERMINAL_KEY_HIT_SLOP}
            onPressIn={(event) => {
              touch.arm(key.id)
              if (!key.repeatable) {
                return
              }
              const prepared = prepareBuiltInPress(key)
              accessoryPresses.current.set(key.id, prepared)
              if (event.type === 'keydown') {
                prepared.hold(TERMINAL_ACCESSORY_REPEAT_DELAY_MS)
              }
            }}
            onPressOut={() => {
              if (key.repeatable) {
                stopAccessoryRepeat()
              }
            }}
            onPress={(event) => {
              // Accessibility clicks have no touch-down to prepare a sender.
              const prepared =
                (key.repeatable &&
                  !isAccessibilityClick(event) &&
                  accessoryPresses.current.get(key.id)) ||
                prepareBuiltInPress(key)
              accessoryPresses.current.delete(key.id)
              touch.fire(key.id, event, () => void prepared.tap())
            }}
            onLongPress={
              key.repeatable
                ? () => {
                    if (touch.stillArmed(key.id)) {
                      accessoryPresses.current.get(key.id)?.hold()
                    }
                  }
                : undefined
            }
            delayLongPress={TERMINAL_ACCESSORY_REPEAT_DELAY_MS}
            // A web <button> clicks on Enter keydown as well, which would send a held key twice.
            accessibilityRole={key.repeatable ? undefined : 'button'}
            accessibilityLabel={key.accessibilityLabel ?? sendKeyLabel(key.label)}
          >
            <Text style={styles.keyText}>{key.label}</Text>
          </Pressable>,
          index + 1 === latchIndex ? latchKeys : null
        ])}
        {isLastRow &&
          customKeys.map((key) => (
            <Pressable
              key={key.id}
              style={({ pressed }) => [...keyStyle({ pressed }), styles.customKey]}
              disabled={!canSend}
              hitSlop={TERMINAL_KEY_HIT_SLOP}
              onPressIn={() => touch.arm(key.id)}
              onPress={(event) => touch.fire(key.id, event, () => onPressCustomKey(key))}
              onLongPress={() => {
                triggerMediumImpact()
                onDeleteCustomKey(key)
              }}
              delayLongPress={400}
              accessibilityRole="button"
              accessibilityLabel={sendKeyLabel(key.label)}
              accessibilityHint={t(
                'session.terminalMoreKeys.deleteKeyHint',
                'Long press to delete this key'
              )}
            >
              <Text style={styles.keyText}>{key.label}</Text>
            </Pressable>
          ))}
        {isLastRow && (
          <Pressable
            style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
            hitSlop={TERMINAL_KEY_HIT_SLOP}
            onPressIn={() => touch.arm('addKey')}
            onPress={(event) => touch.fire('addKey', event, onAddCustomKey)}
            accessibilityRole="button"
            accessibilityLabel={t('session.accessoryKeys.addCustomShortcut', 'Add custom shortcut')}
          >
            <Plus size={15} color={colors.textPrimary} strokeWidth={2.2} />
          </Pressable>
        )}
      </ScrollView>
      {isFirstRow && canCollapseRows && (
        <Pressable
          style={({ pressed }) => [styles.collapseRowButton, pressed && styles.keyPressed]}
          onPress={onToggleCollapseRows}
          hitSlop={TERMINAL_KEY_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={
            rowsCollapsed
              ? t('session.accessoryKeys.expandShortcutRows', 'Expand shortcut rows')
              : t('session.accessoryKeys.collapseShortcutRows', 'Collapse shortcut rows')
          }
        >
          {rowsCollapsed ? (
            <ChevronUp size={15} color={colors.textSecondary} strokeWidth={2.2} />
          ) : (
            <ChevronDown size={15} color={colors.textSecondary} strokeWidth={2.2} />
          )}
        </Pressable>
      )}
    </View>
  )
}
