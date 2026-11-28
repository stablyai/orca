import { Text, View } from 'react-native'
import {
  MobileSegmentedControl,
  type MobileSegment
} from '../components/controls/MobileSegmentedControl'
import { spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
/** A labeled meter choice; the same row sits in Settings and in the usage sheet. */
export function ComposerUsageChoiceRow<Value extends string>({
  label,
  segments,
  selected,
  onSelect,
  inSettings,
  testIDPrefix
}: {
  label: string
  segments: readonly MobileSegment<Value>[]
  selected: Value
  onSelect: (value: Value) => void
  inSettings: boolean
  testIDPrefix: string
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)

  return (
    <View style={[styles.row, inSettings && styles.settingsRow]}>
      <Text style={styles.label}>{label}</Text>
      <MobileSegmentedControl<Value>
        segments={segments}
        selected={selected}
        onSelect={onSelect}
        onSheet={!inSettings}
        testIDPrefix={testIDPrefix}
      />
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: spacing.md
  },
  settingsRow: {
    paddingHorizontal: spacing.md + 2
  },
  label: {
    flexShrink: 1,
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  }
}))
