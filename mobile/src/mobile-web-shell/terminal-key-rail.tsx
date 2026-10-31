import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AppState, Pressable, ScrollView, Text, View } from 'react-native'
import {
  Keyboard,
  ChevronDown,
  Ellipsis,
  Monitor,
  Smartphone,
  ChevronsRight
} from 'lucide-react-native'
import { hasTerminalDirectionPadSpace } from '../layout/side-rail-strip'
import { useSideRailStrip, useSideRailDirectionPadAvailable } from '../layout/side-rail'
import { TERMINAL_ACCESSORY_KEY_DEFINITIONS } from '../terminal/terminal-key-definitions'
import {
  createTerminalAccessoryRepeatController,
  TERMINAL_ACCESSORY_REPEAT_DELAY_MS,
  TERMINAL_ACCESSORY_REPEAT_INTERVAL_MS
} from '../terminal/terminal-accessory-repeat'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { TerminalDirectionPad, type TerminalDirectionPadHandle } from './terminal-direction-pad'
import type {
  BridgeTerminalToolbar,
  BridgeTerminalKeyId,
  BridgeTerminalKeyRail
} from './bridge/bridge-terminal-key'

const KEY_HEIGHT = 40

const ARROW_IDS = ['arrowUp', 'arrowDown', 'arrowLeft', 'arrowRight'] as const
// The same rows the page's key bar shows, so the rail is that bar stood on end.
const SHELL_ROW: readonly BridgeTerminalKeyId[] = [
  'escape',
  'ctrl',
  'tab',
  'alt',
  'shift',
  ...['/', '|', '~', '-', ':'].map((character) => `char:${character}` as const)
]
const AGENT_ROW: readonly BridgeTerminalKeyId[] = [
  'escape',
  'shiftTab',
  'enter',
  'ctrlC',
  'ctrl',
  ...['/', '@', '!'].map((character) => `char:${character}` as const)
]

/** Every key remains reachable by scrolling, regardless of the strip's height. */
export function terminalKeyRailKeys(
  height: number,
  toolbar?: BridgeTerminalToolbar
): BridgeTerminalKeyRail {
  if (height <= 0 || !toolbar) {
    return []
  }
  return [
    'toggleKeyboard',
    'toggleDisplayMode',
    'toggleInputMode',
    ...(toolbar.runsAgent ? AGENT_ROW : SHELL_ROW),
    ...ARROW_IDS,
    'moreKeys'
  ]
}

type RailKey = {
  id: BridgeTerminalKeyId
  label: string
  accessibilityLabel: string
  repeatable?: boolean
  disabled?: boolean
  active?: boolean
  held?: boolean
}

/**
 * The page's terminal keys stood on end in a side inset strip, for a window that has one: the
 * iPhone Duo's status column leaves the rest of its strip empty. Each press goes to the page, which
 * sends it as its own key bar would; arrows repeat while held, as there.
 */
export function TerminalKeyRail({
  keys,
  onKey,
  toolbar,
  inputOwner
}: {
  keys: BridgeTerminalKeyRail
  onKey: (key: BridgeTerminalKeyId) => boolean
  toolbar?: BridgeTerminalToolbar
  inputOwner?: string | null
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [repeat] = useState(() => createTerminalAccessoryRepeatController<BridgeTerminalKeyId>())
  const padRef = useRef<TerminalDirectionPadHandle | null>(null)
  const strip = useSideRailStrip()
  const padAvailable = useSideRailDirectionPadAvailable()
  const pinPad = hasTerminalDirectionPadSpace(strip)
  const showPad =
    strip !== null && padAvailable && toolbar !== undefined && toolbar.directionPadEnabled !== false
  const gesture = useRef({ x: 0, y: 0, cancelled: false, repeated: false })
  const cancelGesture = useCallback(() => {
    gesture.current.cancelled = true
    repeat.cancel()
    padRef.current?.cancel()
  }, [repeat])
  useLayoutEffect(cancelGesture, [cancelGesture, inputOwner])
  useEffect(() => cancelGesture, [cancelGesture, keys, showPad, pinPad])
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        cancelGesture()
      }
    })
    return () => subscription.remove()
  }, [cancelGesture])
  const send = (key: BridgeTerminalKeyId) => Promise.resolve(onKey(key))
  const canSend = toolbar?.canSend ?? false
  const sendKeyLabel = (label: string) =>
    t('session.accessoryKeys.sendKey', 'Send {{label}}', { label })
  const railKey = (id: BridgeTerminalKeyId): RailKey | null => {
    if (id === 'toggleKeyboard') {
      return {
        id,
        label: '',
        accessibilityLabel: toolbar?.keyboardVisible
          ? t('session.accessoryKeys.dismissKeyboard', 'Dismiss keyboard')
          : t('session.accessoryKeys.showKeyboard', 'Show keyboard'),
        disabled:
          !toolbar?.keyboardVisible &&
          !(toolbar?.liveInputEnabled ? toolbar.canSend : toolbar?.canCompose)
      }
    }
    if (id === 'toggleDisplayMode') {
      return {
        id,
        label: '',
        accessibilityLabel: toolbar?.phoneDisplayMode
          ? t('session.terminalMoreKeys.desktopWidth', 'Desktop width')
          : t('session.terminalMoreKeys.phoneWidth', 'Phone width'),
        disabled: !canSend
      }
    }
    if (id === 'toggleInputMode') {
      return {
        id,
        label: '',
        accessibilityLabel: toolbar?.liveInputEnabled
          ? t(
              'session.accessoryKeys.keysModeLabel',
              'Keys mode: typing goes straight to the terminal. Switch to Message mode'
            )
          : t(
              'session.accessoryKeys.messageModeLabel',
              'Message mode: write, then send. Switch to Keys mode'
            ),
        disabled: !toolbar?.canCompose,
        active: toolbar?.liveInputEnabled
      }
    }
    if (id === 'moreKeys') {
      return {
        id,
        label: '',
        accessibilityLabel: t('session.accessoryKeys.moreKeys', 'More keys and actions')
      }
    }
    if (id === 'ctrl' || id === 'alt' || id === 'shift') {
      const latch = toolbar?.modifiers[id] ?? 'off'
      return {
        id,
        label: id === 'ctrl' ? 'Ctrl' : id === 'alt' ? 'Alt' : 'Shift',
        accessibilityLabel:
          id === 'ctrl'
            ? t('session.accessoryKeys.control', 'Control')
            : id === 'alt'
              ? t('session.accessoryKeys.alt', 'Alt')
              : t('session.accessoryKeys.shift', 'Shift'),
        disabled: !canSend,
        held: latch === 'once',
        active: latch === 'locked'
      }
    }
    if (id.startsWith('char:')) {
      const character = id.slice('char:'.length)
      return {
        id,
        label: character,
        accessibilityLabel: t('session.accessoryKeys.typeCharacter', 'Type {{character}}', {
          character
        }),
        disabled: !canSend
      }
    }
    if (id === 'ctrlC') {
      return {
        id,
        label: t('mobileWebShell.terminalKeyRail.ctrlC', 'Ctrl+C'),
        accessibilityLabel: t('session.accessoryKeys.interrupt', 'Interrupt terminal'),
        disabled: !canSend
      }
    }
    const definition = TERMINAL_ACCESSORY_KEY_DEFINITIONS.find((key) => key.id === id)
    return definition
      ? {
          id,
          label: definition.label,
          accessibilityLabel: definition.accessibilityLabel ?? sendKeyLabel(definition.label),
          repeatable: definition.repeatable,
          disabled: !canSend
        }
      : null
  }
  // The pad sends the arrows while it shows, so the column lists them only without it.
  const renderedKeys = keys.flatMap((id) => {
    if (showPad && ARROW_IDS.some((arrow) => arrow === id)) {
      return []
    }
    const key = railKey(id)
    return key ? [key] : []
  })
  const pad =
    showPad && strip && toolbar ? (
      <TerminalDirectionPad
        ref={padRef}
        enabled={toolbar.canSend}
        width={Math.min(68, strip.width - spacing.sm * 2)}
        onKey={onKey}
        onInteractionStart={cancelGesture}
      />
    ) : null
  return (
    <View style={styles.viewport}>
      <ScrollView
        style={styles.viewport}
        contentContainerStyle={styles.rail}
        keyboardShouldPersistTaps="always"
        keyboardDismissMode="none"
        onScrollBeginDrag={cancelGesture}
        onTouchCancel={cancelGesture}
        onTouchMove={(event) => {
          const { pageX, pageY } = event.nativeEvent
          if (
            !gesture.current.cancelled &&
            Math.hypot(pageX - gesture.current.x, pageY - gesture.current.y) > 8
          ) {
            cancelGesture()
          }
        }}
      >
        {!pinPad && pad}
        {renderedKeys.map((key) => (
          <Pressable
            key={key.id}
            style={({ pressed }) => [
              styles.key,
              key.held && styles.keyHeld,
              key.active && styles.keyActive,
              pressed && styles.keyPressed,
              key.disabled && styles.keyDisabled
            ]}
            disabled={key.disabled}
            onPressIn={(event) => {
              repeat.cancel()
              padRef.current?.cancel()
              gesture.current = {
                x: event.nativeEvent.pageX,
                y: event.nativeEvent.pageY,
                cancelled: false,
                repeated: false
              }
            }}
            delayLongPress={TERMINAL_ACCESSORY_REPEAT_DELAY_MS}
            onLongPress={
              key.repeatable
                ? () => {
                    if (!gesture.current.cancelled) {
                      gesture.current.repeated = true
                      repeat.start(key.id, send, TERMINAL_ACCESSORY_REPEAT_INTERVAL_MS)
                    }
                  }
                : undefined
            }
            onPressOut={() => {
              if (key.repeatable) {
                repeat.stop()
              }
            }}
            onPress={() => {
              if (!gesture.current.cancelled && !gesture.current.repeated) {
                onKey(key.id)
              }
            }}
            accessibilityRole="button"
            accessibilityLabel={key.accessibilityLabel}
            accessibilityState={
              key.id === 'ctrl' || key.id === 'alt' || key.id === 'shift'
                ? { selected: Boolean(key.held || key.active) }
                : undefined
            }
          >
            {key.id === 'toggleKeyboard' ? (
              <View style={styles.keyboardGlyph}>
                <Keyboard size={16} color={colors.textSecondary} />
                {toolbar?.keyboardVisible && <ChevronDown size={10} color={colors.textSecondary} />}
              </View>
            ) : key.id === 'toggleDisplayMode' ? (
              toolbar?.phoneDisplayMode ? (
                <Monitor size={16} color={colors.textSecondary} />
              ) : (
                <Smartphone size={16} color={colors.textSecondary} />
              )
            ) : key.id === 'toggleInputMode' ? (
              <ChevronsRight size={16} color={key.active ? colors.bgBase : colors.textSecondary} />
            ) : key.id === 'moreKeys' ? (
              <Ellipsis size={18} color={colors.textSecondary} />
            ) : (
              <Text
                style={[styles.keyText, key.active && styles.keyTextActive]}
                numberOfLines={1}
                adjustsFontSizeToFit
              >
                {key.label}
              </Text>
            )}
          </Pressable>
        ))}
      </ScrollView>
      {pinPad && pad}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  viewport: {
    flex: 1
  },
  rail: {
    alignItems: 'stretch',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  key: {
    height: KEY_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  keyActive: { backgroundColor: colors.textPrimary },
  keyHeld: { borderWidth: 1, borderColor: colors.textPrimary },
  keyDisabled: { opacity: 0.45 },
  keyboardGlyph: { alignItems: 'center' },
  keyPressed: {
    backgroundColor: colors.borderSubtle
  },
  keyText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily
  },
  keyTextActive: { color: colors.bgBase }
}))
