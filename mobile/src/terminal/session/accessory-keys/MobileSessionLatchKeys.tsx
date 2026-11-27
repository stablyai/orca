import { Pressable, Text, type GestureResponderEvent } from 'react-native'
import type { TerminalShortcutModifier } from '../../key-input/terminal-accessory-keys'
import type { StickyModifiers } from '../../key-input/terminal-sticky-modifiers'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { TERMINAL_KEY_HIT_SLOP, terminalDockStylesSheet } from './terminal-dock-styles'
import { useThemedStyles } from '../../../theme/themed-styles'

// Shift is on the keyboard itself; ⇧Tab and the rest of the Shift combos sit under ⋯.
const LATCHES: readonly { id: 'ctrl' | 'alt'; label: string }[] = [
  { id: 'ctrl', label: 'Ctrl' },
  { id: 'alt', label: 'Alt' }
]

/** Ctrl and Alt on the key row: a tap holds one for the next key, a double tap locks it. */
export function MobileSessionLatchKeys({
  modifiers,
  disabled,
  onPressIn,
  onPress
}: {
  modifiers: StickyModifiers
  disabled: boolean
  onPressIn: () => void
  onPress: (modifier: TerminalShortcutModifier, event: GestureResponderEvent) => void
}) {
  const styles = useThemedStyles(terminalDockStylesSheet)
  const t = useMobileTranslation()
  const names: Record<'ctrl' | 'alt', string> = {
    ctrl: t('session.accessoryKeys.control', 'Control'),
    alt: t('session.accessoryKeys.alt', 'Alt')
  }
  return LATCHES.map(({ id, label }) => {
    const latch = modifiers[id]
    return (
      <Pressable
        key={id}
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
        onPress={(event) => onPress(id, event)}
        accessibilityRole="button"
        accessibilityLabel={names[id]}
        accessibilityState={{ selected: latch !== 'off' }}
      >
        <Text style={[styles.keyText, latch === 'locked' && styles.keyTextLocked]}>{label}</Text>
      </Pressable>
    )
  })
}
