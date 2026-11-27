import { useEffect, useMemo, useRef } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  type GestureResponderEvent,
  type ScrollViewInstance
} from 'react-native'
import { ClipboardPaste, Ellipsis } from 'lucide-react-native'
import { triggerMediumImpact } from '../../../platform/haptics/haptics'
import { createTerminalLiveAccessoryInput } from '../../live-input/terminal-live-accessory-input'
import { TERMINAL_ACCESSORY_REPEAT_DELAY_MS } from '../../key-input/terminal-accessory-repeat'
import {
  TERMINAL_ACCESSORY_KEY_DEFINITIONS,
  terminalAccessoryKeyAccessibilityLabel
} from '../../key-input/terminal-key-definitions'
import {
  TERMINAL_ARROW_HIT_SLOP,
  TERMINAL_KEY_HIT_SLOP,
  terminalDockStylesSheet
} from './terminal-dock-styles'
import { useMobileColors } from '../../../theme/use-mobile-color-scheme'
import { useThemedStyles } from '../../../theme/themed-styles'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useKeyboardPersistingTaps } from '../../../platform/keyboard/keyboard-persisting-taps'
import type { MobileSessionController } from '../../../session/use-mobile-session-controller'
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

const BUILT_IN = new Map(TERMINAL_ACCESSORY_KEY_DEFINITIONS.map((key) => [key.id, key]))
const builtIn = (id: string): TerminalAccessoryKey => BUILT_IN.get(id)!
const LEADING_KEYS = [builtIn('escape'), builtIn('tab')]
const ARROW_KEYS = ['arrowUp', 'arrowDown', 'arrowLeft', 'arrowRight'].map(builtIn)
const BACKSPACE_KEY = builtIn('backspace')

// The terminal's key row above the live input: the keys people reach for, then ⋯ for the rest.
export function MobileSessionAccessoryKeys({
  controller,
  onMoreKeys
}: {
  controller: MobileSessionController
  onMoreKeys: () => void
}) {
  const styles = useThemedStyles(terminalDockStylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const {
    customKeys,
    setDeleteKeyTarget,
    canPaste,
    canSend,
    handleAccessoryKey,
    stopAccessoryRepeat,
    cancelAccessoryRepeat,
    prepareAccessoryPress,
    handlePaste,
    dockKeys,
    activeSessionTab,
    terminals,
    smartRailEnabled
  } = controller
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
  // A key fires on release; ⌫ and the arrows repeat while held.
  const builtInPressProps = (key: TerminalAccessoryKey) => ({
    disabled: !canSend,
    onPressIn: (event: GestureResponderEvent) => {
      touch.arm(key.id)
      if (!key.repeatable) {
        return
      }
      const prepared = prepareBuiltInPress(key)
      accessoryPresses.current.set(key.id, prepared)
      if (event.type === 'keydown') {
        prepared.hold(TERMINAL_ACCESSORY_REPEAT_DELAY_MS)
      }
    },
    onPressOut: () => {
      if (key.repeatable) {
        stopAccessoryRepeat()
      }
    },
    onPress: (event: GestureResponderEvent) => {
      // Accessibility clicks have no touch-down to prepare a sender.
      const prepared =
        (key.repeatable && !isAccessibilityClick(event) && accessoryPresses.current.get(key.id)) ||
        prepareBuiltInPress(key)
      accessoryPresses.current.delete(key.id)
      touch.fire(key.id, event, () => void prepared.tap())
    },
    onLongPress: key.repeatable
      ? () => {
          if (touch.stillArmed(key.id)) {
            accessoryPresses.current.get(key.id)?.hold()
          }
        }
      : undefined,
    delayLongPress: TERMINAL_ACCESSORY_REPEAT_DELAY_MS,
    // A web <button> clicks on Enter keydown as well, which would send a held key twice.
    accessibilityRole: key.repeatable ? undefined : ('button' as const),
    accessibilityLabel: terminalAccessoryKeyAccessibilityLabel(key, t) ?? sendKeyLabel(key.label)
  })
  const builtInKey = (key: TerminalAccessoryKey) => (
    <Pressable
      key={key.id}
      style={keyStyle}
      hitSlop={TERMINAL_KEY_HIT_SLOP}
      {...builtInPressProps(key)}
    >
      <Text style={styles.keyText}>{key.label}</Text>
    </Pressable>
  )
  return (
    <View ref={keepsKeyboard} style={styles.keyRow} {...touch.rowTouchHandlers}>
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
        {LEADING_KEYS.map(builtInKey)}
        <MobileSessionLatchKeys
          modifiers={dockKeys.modifiers}
          disabled={!canSend}
          onPressIn={() => touch.arm('latch')}
          onPress={(modifier, event) =>
            touch.fire('latch', event, () => dockKeys.tapModifier(modifier))
          }
        />
        <View style={[styles.arrowCluster, !canSend && styles.disabled]}>
          {ARROW_KEYS.map((key, index) => (
            <Pressable
              key={key.id}
              style={({ pressed }) => [
                styles.arrowKey,
                index > 0 && styles.arrowKeyDivided,
                pressed && styles.arrowKeyPressed
              ]}
              hitSlop={{
                ...TERMINAL_ARROW_HIT_SLOP,
                left: index === 0 ? TERMINAL_KEY_HIT_SLOP.left : 0,
                right: index === ARROW_KEYS.length - 1 ? TERMINAL_KEY_HIT_SLOP.right : 0
              }}
              {...builtInPressProps(key)}
            >
              <Text style={styles.keyText}>{key.label}</Text>
            </Pressable>
          ))}
        </View>
        {builtInKey(BACKSPACE_KEY)}
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
            <ClipboardPaste size={15} color={colors.textPrimary} strokeWidth={2} />
          </Pressable>
        )}
        {customKeys
          .filter((key) => key.visible !== false)
          .map((key) => (
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
              <Text style={styles.keyText} numberOfLines={1}>
                {key.label}
              </Text>
            </Pressable>
          ))}
      </ScrollView>
      {/* Pinned outside the scroll, so the rest of the keys are always one tap away. */}
      <Pressable
        style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
        hitSlop={TERMINAL_KEY_HIT_SLOP}
        onPress={onMoreKeys}
        accessibilityRole="button"
        accessibilityLabel={t('session.accessoryKeys.moreKeys', 'More keys and actions')}
      >
        <Ellipsis size={16} color={colors.textPrimary} strokeWidth={2.2} />
      </Pressable>
    </View>
  )
}
