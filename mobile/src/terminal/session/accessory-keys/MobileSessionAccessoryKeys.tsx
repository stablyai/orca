import { useEffect, useMemo, useRef } from 'react'
import { View, Text, ScrollView, Pressable, type ScrollViewInstance } from 'react-native'
import {
  ChevronDown,
  Keyboard as KeyboardIcon,
  Monitor,
  Plus,
  Smartphone
} from 'lucide-react-native'
import { triggerMediumImpact } from '../../../platform/haptics/haptics'
import { createTerminalLiveAccessoryInput } from '../../live-input/terminal-live-accessory-input'
import { TERMINAL_ACCESSORY_REPEAT_DELAY_MS } from '../../key-input/terminal-accessory-repeat'
import { getVisibleTerminalAccessoryKeys } from '../../key-input/terminal-accessory-layout'
import { useDirectionPadAvailable } from '../../../layout/use-shell-side-rail'
import { isTerminalPhoneDisplayMode } from '../pane-layout/terminal-phone-display-mode'
import { TERMINAL_KEY_HIT_SLOP, terminalDockStyles as styles } from './terminal-dock-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors } from '../../../theme/mobile-theme'
import { styles as sessionStyles } from '../../../session/mobile-session-styles'
import { useKeyboardPersistingTaps } from '../../../platform/keyboard/keyboard-persisting-taps'
import type { MobileSessionController } from '../../../session/use-mobile-session-controller'
import { useMobileSessionKeyboardLift } from '../input-controls/use-mobile-session-keyboard-lift'
import {
  AGENT_SMART_KEY_STEP_MS,
  type AgentSmartKey
} from '../../../../../src/shared/terminal/input/agent-smart-keys'
import type { TerminalAccessoryKey } from '../../key-input/terminal-accessory-keys'
import { resolveMobileTerminalTabSmartKeys } from '../../../session/tabs/mobile-terminal-tab-agent'
import { MobileSessionSmartKeys } from './MobileSessionSmartKeys'
import { MobileSessionLatchKeys } from './MobileSessionLatchKeys'
import { isAccessibilityClick, useTerminalKeyRowTouch } from './use-terminal-key-row-touch'

type PreparedPress = ReturnType<MobileSessionController['prepareAccessoryPress']>

// The terminal's key row above the live input; every key goes straight to the terminal.
export function MobileSessionAccessoryKeys({
  controller
}: {
  controller: MobileSessionController
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const {
    activeHandle,
    customKeys,
    setShowCustomKeyModal,
    setDeleteKeyTarget,
    visibleBuiltInIds,
    visibleBuiltInAccessoryKeys,
    terminalModes,
    canPaste,
    canSend,
    toggleDisplayMode,
    handleAccessoryKey,
    dismissSoftwareKeyboard,
    stopAccessoryRepeat,
    cancelAccessoryRepeat,
    prepareAccessoryPress,
    handlePaste,
    dockKeys,
    activeSessionTab,
    terminals,
    smartRailEnabled
  } = controller
  const keyboardLift = useMobileSessionKeyboardLift(controller.dockBottomInset)
  const accessoryPresses = useRef(new Map<string, PreparedPress>())
  const scrollRef = useRef<ScrollViewInstance>(null)
  const latestSmartKeys = useMemo(
    () =>
      smartRailEnabled ? resolveMobileTerminalTabSmartKeys(activeSessionTab, terminals) : null,
    [smartRailEnabled, activeSessionTab, terminals]
  )
  const touch = useTerminalKeyRowTouch({
    scrollRef,
    latest: latestSmartKeys,
    cancelAccessoryRepeat
  })
  const smartKeys = touch.shown
  const keepsKeyboard = useKeyboardPersistingTaps('always')
  // An unmounting Pressable never fires onPressOut, so a held key would outlive its row.
  useEffect(() => cancelAccessoryRepeat, [cancelAccessoryRepeat])
  const phoneDisplay = isTerminalPhoneDisplayMode(activeHandle, terminalModes)
  // A D-pad device's layout leaves the arrows to the rail, and this row only shows without the rail.
  const padAvailable = useDirectionPadAvailable()
  const builtInKeys = useMemo(
    () =>
      padAvailable
        ? getVisibleTerminalAccessoryKeys(visibleBuiltInIds, true)
        : visibleBuiltInAccessoryKeys,
    [padAvailable, visibleBuiltInIds, visibleBuiltInAccessoryKeys]
  )
  const keyStyle = ({ pressed }: { pressed: boolean }) => [
    styles.key,
    pressed && styles.keyPressed,
    !canSend && styles.disabled
  ]
  const sendKeyLabel = (label: string) =>
    t('session.accessoryKeys.sendKey', 'Send {{label}}', { label })
  // Held Shift, Ctrl or Alt turn a key into its combo and are used up when it sends; keys that take none send as they are.
  const prepareBuiltInPress = (key: TerminalAccessoryKey): PreparedPress => {
    const chord = dockKeys.chordInput(key.id)
    const press = prepareAccessoryPress(chord ?? createTerminalLiveAccessoryInput(key))
    const takeChord = () => {
      if (chord) {
        dockKeys.takeModifiers()
      }
    }
    return {
      tap: () => {
        takeChord()
        return press.tap()
      },
      hold: (firstRepeatDelayMs) => {
        takeChord()
        press.hold(firstRepeatDelayMs)
      }
    }
  }
  // Later writes belong to the same press, so a scroll after release mustn't drop them; a tab switch does.
  const sendSmartKey = (key: AgentSmartKey) => {
    const handle = controller.activeHandleRef.current
    void (async () => {
      for (const [index, bytes] of key.writes.entries()) {
        if (index > 0) {
          await new Promise((resolve) => setTimeout(resolve, AGENT_SMART_KEY_STEP_MS))
        }
        if (controller.activeHandleRef.current !== handle) {
          return
        }
        if (!(await prepareAccessoryPress({ bytes }).tap())) {
          return
        }
      }
    })()
  }
  const latchIndex = builtInKeys.findIndex((key) => key.id === 'tab') + 1
  const latchKeys = (
    <MobileSessionLatchKeys
      key="latches"
      modifiers={dockKeys.modifiers}
      disabled={!canSend}
      onPressIn={() => touch.arm('latch')}
      onPress={(modifier, event) =>
        touch.fire('latch', event, () => dockKeys.tapModifier(modifier))
      }
    />
  )
  return (
    <View ref={keepsKeyboard} style={styles.keyRow} {...touch.rowTouchHandlers}>
      {/* Why: fixed keyboard escape hatch; outside the ScrollView so it can't scroll away (#5106). */}
      {keyboardLift > 0 && (
        <Pressable
          style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          onPress={dismissSoftwareKeyboard}
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
        {smartKeys ? (
          <MobileSessionSmartKeys
            keySet={smartKeys}
            disabled={!canSend}
            onPressIn={(key) => touch.arm(`smart:${key.id}`)}
            onPress={(key, event) => touch.fire(`smart:${key.id}`, event, () => sendSmartKey(key))}
          />
        ) : null}
        <Pressable
          style={keyStyle}
          disabled={!canSend}
          hitSlop={TERMINAL_KEY_HIT_SLOP}
          onPressIn={() => touch.arm('displayMode')}
          onPress={(event) =>
            touch.fire('displayMode', event, () => {
              if (activeHandle) {
                void toggleDisplayMode(activeHandle)
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
        {canPaste && (
          <Pressable
            style={keyStyle}
            disabled={!canSend}
            hitSlop={TERMINAL_KEY_HIT_SLOP}
            onPressIn={() => touch.arm('paste')}
            onPress={(event) => touch.fire('paste', event, () => void handlePaste())}
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
        {builtInKeys.flatMap((key, index) => [
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
        {customKeys.map((key) => (
          <Pressable
            key={key.id}
            style={({ pressed }) => [...keyStyle({ pressed }), styles.customKey]}
            disabled={!canSend}
            hitSlop={TERMINAL_KEY_HIT_SLOP}
            onPressIn={() => touch.arm(key.id)}
            onPress={(event) =>
              touch.fire(key.id, event, () => void handleAccessoryKey({ bytes: key.bytes }))
            }
            onLongPress={() => {
              triggerMediumImpact()
              setDeleteKeyTarget(key)
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
        <Pressable
          style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          hitSlop={TERMINAL_KEY_HIT_SLOP}
          onPressIn={() => touch.arm('addKey')}
          onPress={(event) => touch.fire('addKey', event, () => setShowCustomKeyModal(true))}
          accessibilityRole="button"
          accessibilityLabel={t('session.accessoryKeys.addCustomShortcut', 'Add custom shortcut')}
        >
          <Plus size={15} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
      </ScrollView>
    </View>
  )
}
