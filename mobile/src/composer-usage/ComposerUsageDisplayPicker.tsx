import { Text, View } from 'react-native'
import type { UsagePercentageDisplay } from '../../../src/shared/agent-usage/display/usage-percentage-display'
import { MobileSegmentedControl } from '../components/controls/MobileSegmentedControl'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import {
  setComposerUsageDisplay,
  useComposerUsageDisplay
} from './composer-usage-display-preference'

/** Picks whether the composer meter shows used or remaining. One choice for every composer. */
export function ComposerUsageDisplayPicker({ inSettings = false }: { inSettings?: boolean }) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const display = useComposerUsageDisplay()
  return (
    <View style={[styles.row, inSettings && styles.settingsRow]}>
      <Text style={styles.label}>{t('composerUsage.display.label', 'Meter shows')}</Text>
      <MobileSegmentedControl<UsagePercentageDisplay>
        segments={[
          {
            value: 'used',
            label: t('composerUsage.display.used', 'Used'),
            accessibilityLabel: t(
              'composerUsage.display.usedHint',
              'Show how much of the window is used'
            )
          },
          {
            value: 'remaining',
            label: t('composerUsage.display.remaining', 'Remaining'),
            accessibilityLabel: t(
              'composerUsage.display.remainingHint',
              'Show how much of the window is left'
            )
          }
        ]}
        selected={display}
        onSelect={setComposerUsageDisplay}
        onSheet={!inSettings}
        testIDPrefix="composer-usage-display-"
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
