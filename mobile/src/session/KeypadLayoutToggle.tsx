import { Keyboard, LayoutGrid } from 'lucide-react-native'
import type { ReactElement } from 'react'
import { Pressable } from 'react-native'

import type { TerminalKeypadLayout } from '../storage/preferences'
import { colors } from '../theme/mobile-theme'
import { mobileSessionCommandInputStyles as styles } from './mobile-session-command-input-styles'

type Props = {
  layout: TerminalKeypadLayout
  onChange: (layout: TerminalKeypadLayout) => void
}

// Why: one button flips between the shortcut row and the full on-screen keyboard;
// its icon shows what you'll switch TO, reading as a single toggle.
export function KeypadLayoutToggle({ layout, onChange }: Props): ReactElement {
  const goingToKeyboard = layout === 'shortcuts'
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={goingToKeyboard ? 'Switch to full keyboard' : 'Switch to shortcut keys'}
      accessibilityState={{ expanded: layout === 'keyboard' }}
      onPress={() => onChange(goingToKeyboard ? 'keyboard' : 'shortcuts')}
      style={({ pressed }) => [styles.keypadToggleButton, pressed && styles.keypadTogglePressed]}
    >
      {goingToKeyboard ? (
        <Keyboard size={18} color={colors.textSecondary} strokeWidth={2} />
      ) : (
        <LayoutGrid size={18} color={colors.textSecondary} strokeWidth={2} />
      )}
    </Pressable>
  )
}
