import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { AppState, Pressable, Text, View } from 'react-native'
import {
  createTerminalAccessoryRepeatController,
  TERMINAL_ACCESSORY_REPEAT_DELAY_MS,
  TERMINAL_ACCESSORY_REPEAT_INTERVAL_MS
} from '../../terminal/key-input/terminal-accessory-repeat'
import { radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'

export const TERMINAL_DIRECTION_KEYS = ['arrowUp', 'arrowLeft', 'arrowRight', 'arrowDown'] as const
type DirectionKey = (typeof TERMINAL_DIRECTION_KEYS)[number]
export type TerminalDirectionPadHandle = { cancel: () => void }

const DIRECTIONS = [
  { key: 'arrowUp', glyph: '↑' },
  { key: 'arrowLeft', glyph: '←' },
  { key: 'arrowRight', glyph: '→' },
  { key: 'arrowDown', glyph: '↓' }
] as const

function directionLabel(key: DirectionKey, t: Translate): string {
  return key === 'arrowUp'
    ? t('mobileWebShell.terminalDirectionPad.up', 'D-pad up')
    : key === 'arrowLeft'
      ? t('mobileWebShell.terminalDirectionPad.left', 'D-pad left')
      : key === 'arrowRight'
        ? t('mobileWebShell.terminalDirectionPad.right', 'D-pad right')
        : t('mobileWebShell.terminalDirectionPad.down', 'D-pad down')
}

export const TerminalDirectionPad = forwardRef<
  TerminalDirectionPadHandle,
  {
    enabled: boolean
    width: number
    onKey: (key: DirectionKey) => boolean
    onInteractionStart: () => void
  }
>(function TerminalDirectionPad({ enabled, width, onKey, onInteractionStart }, ref) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const [repeat] = useState(() => createTerminalAccessoryRepeatController<DirectionKey>())
  const delivery = useRef({ enabled, onKey })
  useLayoutEffect(() => {
    delivery.current = { enabled, onKey }
  }, [enabled, onKey])
  const gesture = useRef({ x: 0, y: 0, cancelled: true, repeated: false })
  const cancel = useCallback(() => {
    gesture.current.cancelled = true
    repeat.cancel()
  }, [repeat])
  useImperativeHandle(ref, () => ({ cancel }), [cancel])
  useLayoutEffect(() => {
    delivery.current.enabled = enabled
    if (!enabled) {
      cancel()
    }
    return () => {
      delivery.current.enabled = false
      cancel()
    }
  }, [enabled, cancel])
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        cancel()
      }
    })
    return () => subscription.remove()
  }, [cancel])
  const send = (key: DirectionKey) =>
    Promise.resolve(delivery.current.enabled && delivery.current.onKey(key))
  const button = (direction: (typeof DIRECTIONS)[number]) => (
    <Pressable
      key={direction.key}
      accessibilityRole="button"
      accessibilityLabel={directionLabel(direction.key, t)}
      accessibilityHint={t(
        'mobileWebShell.terminalDirectionPad.hint',
        'Sends an arrow key. Hold to repeat.'
      )}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      style={({ pressed }) => [styles.key, pressed && styles.pressed, !enabled && styles.disabled]}
      onPressIn={(event) => {
        onInteractionStart()
        repeat.cancel()
        gesture.current = {
          x: event.nativeEvent.pageX,
          y: event.nativeEvent.pageY,
          cancelled: !delivery.current.enabled,
          repeated: false
        }
      }}
      delayLongPress={TERMINAL_ACCESSORY_REPEAT_DELAY_MS}
      onLongPress={() => {
        if (!gesture.current.cancelled && delivery.current.enabled) {
          gesture.current.repeated = true
          repeat.start(direction.key, send, TERMINAL_ACCESSORY_REPEAT_INTERVAL_MS)
        }
      }}
      onPressOut={() => repeat.stop()}
      onPress={() => {
        if (!gesture.current.cancelled && !gesture.current.repeated && delivery.current.enabled) {
          delivery.current.onKey(direction.key)
        }
      }}
      onAccessibilityTap={() => {
        onInteractionStart()
        cancel()
        if (delivery.current.enabled) {
          delivery.current.onKey(direction.key)
        }
      }}
    >
      <Text style={styles.glyph}>{direction.glyph}</Text>
    </Pressable>
  )
  return (
    <View
      style={[styles.pad, { width }]}
      onTouchCancel={cancel}
      onTouchMove={(event) => {
        if (
          Math.hypot(
            event.nativeEvent.pageX - gesture.current.x,
            event.nativeEvent.pageY - gesture.current.y
          ) > 8
        ) {
          cancel()
        }
      }}
    >
      {button(DIRECTIONS[0])}
      <View style={styles.middle}>
        {button(DIRECTIONS[1])}
        {button(DIRECTIONS[2])}
      </View>
      {button(DIRECTIONS[3])}
    </View>
  )
})

const stylesSheet = themedStyleSheet((colors) => ({
  pad: { alignSelf: 'center', gap: spacing.xs, paddingVertical: spacing.xs },
  middle: { flexDirection: 'row', gap: spacing.xs },
  key: {
    flexGrow: 1,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderRadius: radii.control
  },
  pressed: { backgroundColor: colors.borderSubtle },
  disabled: { opacity: 0.45 },
  glyph: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontFamily: typography.monoFamily
  }
}))
