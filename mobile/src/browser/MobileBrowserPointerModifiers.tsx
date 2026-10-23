import { StyleSheet, View } from 'react-native'
import { FilterChip } from '../components/ui/FilterChip'
import { triggerSelection } from '../platform/haptics'
import { spacing } from '../theme/mobile-theme'

export type BrowserPointerModifier = 'cmd' | 'ctrl' | 'alt' | 'shift'

export const BROWSER_POINTER_MODIFIERS: { id: BrowserPointerModifier; label: string }[] = [
  { id: 'cmd', label: 'Cmd' },
  { id: 'ctrl', label: 'Ctrl' },
  { id: 'alt', label: 'Alt' },
  { id: 'shift', label: 'Shift' }
]

type Props = {
  disabled: boolean
  selectedModifiers: BrowserPointerModifier[]
  onToggle: (modifier: BrowserPointerModifier) => void
}

export function MobileBrowserPointerModifiers({
  disabled,
  selectedModifiers,
  onToggle
}: Props): React.JSX.Element {
  return (
    <View style={styles.modifierRow}>
      {BROWSER_POINTER_MODIFIERS.map((modifier) => (
        <FilterChip
          key={modifier.id}
          label={modifier.label}
          active={selectedModifiers.includes(modifier.id)}
          disabled={disabled}
          onPress={() => {
            triggerSelection()
            onToggle(modifier.id)
          }}
          accessibilityLabel={`${modifier.label} click modifier`}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  modifierRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.sm }
})
