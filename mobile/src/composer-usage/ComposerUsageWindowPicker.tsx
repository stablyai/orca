import { Text, View } from 'react-native'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  composerUsageWindowToggleChoices,
  type ComposerUsageWindowChoice,
  type UsageWindowEntry
} from './agent-usage-provider'
import { setComposerUsageWindow, useComposerUsageWindow } from './composer-usage-window-preference'

/** Picks the window the composer meter shows; lives in Settings and in the usage sheet. */
export function ComposerUsageWindowPicker({
  inSettings = false,
  windows
}: {
  inSettings?: boolean
  /** The open provider's windows. Settings has no provider, so it keeps both choices. */
  windows?: readonly UsageWindowEntry[]
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const choice = useComposerUsageWindow()
  const choices = windows
    ? composerUsageWindowToggleChoices(windows)
    : (['session', 'weekly'] as const)
  if (choices.length < 2) {
    return null
  }
  const segments = choices.map((value) => ({
    value,
    label:
      value === 'session'
        ? t('composerUsage.picker.session', '5-hour')
        : t('composerUsage.picker.weekly', 'Weekly')
  }))
  return (
    <View style={[styles.row, inSettings && styles.settingsRow]}>
      <Text style={styles.label}>{t('composerUsage.picker.label', 'Show in composer')}</Text>
      <MobileSegmentedControl<ComposerUsageWindowChoice>
        segments={segments}
        selected={choice}
        onSelect={setComposerUsageWindow}
        onSheet={!inSettings}
        testIDPrefix="composer-usage-window-"
      />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
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
