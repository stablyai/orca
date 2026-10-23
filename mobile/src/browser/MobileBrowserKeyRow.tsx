import { StyleSheet, View } from 'react-native'
import { FilterChip } from '../components/ui/FilterChip'
import { triggerSelection } from '../platform/haptics'
import { spacing } from '../theme/mobile-theme'

const BROWSER_KEYS = ['Enter', 'Backspace', 'Tab', 'Escape'] as const

type Props = {
  disabled: boolean
  onKeypress: (key: string) => void
}

export function MobileBrowserKeyRow({ disabled, onKeypress }: Props): React.JSX.Element {
  return (
    <View style={styles.keyRow}>
      {BROWSER_KEYS.map((key) => (
        <FilterChip
          key={key}
          label={key === 'Backspace' ? '⌫' : key === 'Escape' ? 'Esc' : key}
          accessibilityLabel={`Send ${key}`}
          disabled={disabled}
          onPress={() => {
            triggerSelection()
            onKeypress(key)
          }}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  keyRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.sm }
})
