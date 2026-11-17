import { Pressable, Text, type GestureResponderEvent } from 'react-native'
import type { TerminalShortcutModifier } from '../../key-input/terminal-accessory-keys'
import type { StickyModifiers } from '../../key-input/terminal-sticky-modifiers'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { TERMINAL_KEY_HIT_SLOP, terminalDockStyles as styles } from './terminal-dock-styles'

/** Shift, Ctrl or Alt on the key row: a tap holds it for the next key, a double tap locks it. */
export function MobileSessionLatchKey({
  modifier,
  label,
  accessibilityLabel,
  modifiers,
  disabled,
  onPressIn,
  onPress
}: {
  modifier: TerminalShortcutModifier
  label: string
  accessibilityLabel: string
  modifiers: StickyModifiers
  disabled: boolean
  onPressIn: () => void
  onPress: (event: GestureResponderEvent) => void
}) {
  useMobileColorScheme()
  const latch = modifiers[modifier]
  return (
    <Pressable
      style={({ pressed }) => [
        styles.key,
        styles.keyLatch,
        latch === 'once' && styles.keyLatched,
        latch === 'locked' && styles.keyLocked,
        pressed && styles.keyPressed,
        disabled && styles.disabled
      ]}
      disabled={disabled}
      hitSlop={TERMINAL_KEY_HIT_SLOP}
      onPressIn={onPressIn}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: latch !== 'off' }}
    >
      <Text style={[styles.keyText, latch === 'locked' && styles.keyTextLocked]}>{label}</Text>
    </Pressable>
  )
}
