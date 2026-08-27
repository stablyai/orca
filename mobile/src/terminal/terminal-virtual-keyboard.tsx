import { useRef, useState, type ReactElement } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { buildTerminalShortcutKey, type TerminalShortcutModifier } from './terminal-accessory-keys'

export const KEYBOARD_HEIGHT = 200

type Props = {
  canSend: boolean
  onSendBytes: (bytes: string) => void
  onRepeatBytes?: (bytes: string) => void
}

type KeyDef = {
  label: string
  accessibilityLabel?: string
  char?: string // printable character routed through modifier/caps logic
  special?: string // named special key (escape, tab, enter, arrows...)
  weight?: number // relative width in the row
  modifier?: 'ctrl' | 'alt' | 'shift' | 'caps'
  repeat?: boolean
}

const REPEAT_START_DELAY = 400
const REPEAT_INTERVAL = 45

const SHIFTED_DIGITS: Record<string, string> = {
  '`': '~',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+'
}

// PC layout, top to bottom. Wide keys carry a flex weight > 1.
const ROW_0: KeyDef[] = [
  { label: 'Esc', accessibilityLabel: 'Escape', special: 'escape', weight: 1.3 },
  charKey('`'),
  ...'1234567890'.split('').map(charKey),
  charKey('-'),
  charKey('='),
  { label: '⌫', accessibilityLabel: 'Backspace', special: 'backspace', weight: 2, repeat: true }
]
const ROW_1: KeyDef[] = [
  { label: 'Tab', accessibilityLabel: 'Tab', special: 'tab', weight: 1.5 },
  ...'qwertyuiop'.split('').map(charKey),
  charKey('['),
  charKey(']'),
  charKey('\\')
]
const ROW_2: KeyDef[] = [
  { label: 'Caps', accessibilityLabel: 'Caps lock', modifier: 'caps', weight: 1.75 },
  ...'asdfghjkl'.split('').map(charKey),
  charKey(';'),
  charKey("'"),
  { label: 'Enter', accessibilityLabel: 'Enter', special: 'enter', weight: 2 }
]
const ROW_3: KeyDef[] = [
  { label: '⇧', accessibilityLabel: 'Shift', modifier: 'shift', weight: 2.25 },
  ...'zxcvbnm'.split('').map(charKey),
  charKey(','),
  charKey('.'),
  charKey('/')
]
// Single bottom row: modifiers + space on the left, the four arrows grouped on
// the right. One row keeps the keyboard to five rows so Esc stays visible.
const ROW_4: KeyDef[] = [
  { label: 'Ctrl', accessibilityLabel: 'Control', modifier: 'ctrl', weight: 1.4 },
  { label: 'Alt', accessibilityLabel: 'Alt', modifier: 'alt', weight: 1.1 },
  { label: 'space', accessibilityLabel: 'Space', special: 'space', weight: 5 },
  { label: '↑', accessibilityLabel: 'Arrow up', special: 'arrowUp', repeat: true },
  { label: '←', accessibilityLabel: 'Arrow left', special: 'arrowLeft', repeat: true },
  { label: '↓', accessibilityLabel: 'Arrow down', special: 'arrowDown', repeat: true },
  { label: '→', accessibilityLabel: 'Arrow right', special: 'arrowRight', repeat: true }
]
const ROWS = [ROW_0, ROW_1, ROW_2, ROW_3, ROW_4]

function charKey(char: string): KeyDef {
  return { label: char, char }
}

export function TerminalVirtualKeyboard({
  canSend,
  onSendBytes,
  onRepeatBytes
}: Props): ReactElement {
  const [ctrl, setCtrl] = useState(false)
  const [alt, setAlt] = useState(false)
  const [shift, setShift] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  const lastShiftTap = useRef(0)
  const repeatTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatInterval = useRef<ReturnType<typeof setInterval> | null>(null)

  const modifiers: TerminalShortcutModifier[] = []
  if (ctrl) {
    modifiers.push('ctrl')
  }
  if (alt) {
    modifiers.push('alt')
  }
  if (shift) {
    modifiers.push('shift')
  }

  function clearOneShotModifiers(): void {
    setShift(false)
    setCtrl(false)
    setAlt(false)
  }

  function sendPrintable(key: string): void {
    if (!canSend) {
      return
    }
    // Why: mirror a physical keyboard — shift or caps lock uppercases letters.
    const useShift = shift || (capsLock && key >= 'a' && key <= 'z')
    const effectiveModifiers: TerminalShortcutModifier[] =
      useShift && !shift ? [...modifiers, 'shift'] : modifiers
    const built = buildTerminalShortcutKey({ key, modifiers: effectiveModifiers })
    if (built) {
      onSendBytes(built.bytes)
    }
    if (capsLock) {
      setCtrl(false)
      setAlt(false)
    } else {
      clearOneShotModifiers()
    }
  }

  function sendSpecial(key: string): void {
    if (!canSend) {
      return
    }
    const built = buildTerminalShortcutKey({ key, modifiers })
    if (built) {
      onSendBytes(built.bytes)
    }
    clearOneShotModifiers()
  }

  function stopRepeat(): void {
    if (repeatTimer.current) {
      clearTimeout(repeatTimer.current)
      repeatTimer.current = null
    }
    if (repeatInterval.current) {
      clearInterval(repeatInterval.current)
      repeatInterval.current = null
    }
  }

  function startRepeat(key: string): void {
    if (!canSend || !onRepeatBytes) {
      return
    }
    const built = buildTerminalShortcutKey({ key, modifiers })
    if (!built) {
      return
    }
    stopRepeat()
    onRepeatBytes(built.bytes)
    repeatTimer.current = setTimeout(() => {
      repeatInterval.current = setInterval(() => onRepeatBytes(built.bytes), REPEAT_INTERVAL)
    }, REPEAT_START_DELAY)
  }

  function toggleShift(): void {
    // Why: double-tap shift is the phone-keyboard caps-lock gesture; a real Caps key also exists.
    const now = Date.now()
    if (shift && now - lastShiftTap.current < 350) {
      setCapsLock(true)
      setShift(true)
    } else {
      setShift((value) => !value)
    }
    lastShiftTap.current = now
  }

  function onKey(def: KeyDef): void {
    if (def.modifier === 'ctrl') {
      return setCtrl((v) => !v)
    }
    if (def.modifier === 'alt') {
      return setAlt((v) => !v)
    }
    if (def.modifier === 'shift') {
      return toggleShift()
    }
    if (def.modifier === 'caps') {
      return setCapsLock((v) => !v)
    }
    if (def.char) {
      return sendPrintable(def.char)
    }
    if (def.special) {
      return sendSpecial(def.special)
    }
  }

  function labelFor(def: KeyDef): string {
    if (def.modifier === 'shift') {
      return capsLock ? '⇪' : def.label
    }
    if (def.modifier === 'caps') {
      return capsLock ? '⇪ Caps' : def.label
    }
    if (def.char) {
      if (def.char >= 'a' && def.char <= 'z') {
        return shift !== capsLock ? def.char.toUpperCase() : def.char
      }
      if (shift && SHIFTED_DIGITS[def.char]) {
        return SHIFTED_DIGITS[def.char]!
      }
    }
    return def.label
  }

  function isActive(def: KeyDef): boolean {
    if (def.modifier === 'ctrl') {
      return ctrl
    }
    if (def.modifier === 'alt') {
      return alt
    }
    if (def.modifier === 'shift') {
      return shift
    }
    if (def.modifier === 'caps') {
      return capsLock
    }
    return false
  }

  return (
    <View style={styles.container} pointerEvents={canSend ? 'auto' : 'none'}>
      {ROWS.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.row}>
          {row.map((def) => (
            <Key
              key={`${rowIndex}-${def.label}-${def.special ?? def.char ?? def.modifier}`}
              def={def}
              label={labelFor(def)}
              active={isActive(def)}
              disabled={!canSend}
              onPress={onKey}
              onPressIn={def.repeat ? startRepeat : undefined}
              onPressOut={def.repeat ? stopRepeat : undefined}
            />
          ))}
        </View>
      ))}
    </View>
  )
}

type KeyProps = {
  def: KeyDef
  label: string
  active?: boolean
  disabled?: boolean
  onPress: (def: KeyDef) => void
  onPressIn?: (special: string) => void
  onPressOut?: () => void
}

function Key({
  def,
  label,
  active,
  disabled,
  onPress,
  onPressIn,
  onPressOut
}: KeyProps): ReactElement {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={def.accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={def.repeat ? undefined : () => onPress(def)}
      onPressIn={def.repeat && def.special ? () => onPressIn?.(def.special!) : undefined}
      onPressOut={def.repeat ? onPressOut : undefined}
      style={({ pressed }) => [
        styles.key,
        { flex: def.weight ?? 1 },
        active && styles.keyActive,
        pressed && !active && styles.keyPressed
      ]}
    >
      <Text
        style={[
          styles.keyText,
          Array.from(label).length > 1 && styles.keyTextWide,
          active && styles.keyTextActive
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  )
}

const KEY_HEIGHT = 34
const KEY_GAP = 5

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: KEY_GAP
  },
  row: {
    flexDirection: 'row',
    gap: KEY_GAP
  },
  key: {
    height: KEY_HEIGHT,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderRadius: radii.button,
    paddingHorizontal: 2
  },
  keyPressed: {
    backgroundColor: colors.borderSubtle
  },
  keyActive: {
    backgroundColor: colors.textPrimary
  },
  keyText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: typography.monoFamily
  },
  // Why: word labels (Esc/Tab/Ctrl/Alt/space) don't fit a single-character key width at 12px.
  keyTextWide: {
    fontSize: 11
  },
  keyTextActive: {
    color: colors.bgBase,
    fontWeight: '700'
  }
})
