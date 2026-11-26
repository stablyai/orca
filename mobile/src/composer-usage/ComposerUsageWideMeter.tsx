import { Pressable, Text } from 'react-native'
import { composerInputStyles } from '../components/composer-input/composer-input-styles'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import type { ComposerUsageMeterReadout } from './composer-usage-meter-readout'
import { ComposerUsageTrack } from './ComposerUsageTrack'

/** The space between the wide meter's label, bar and percent. */
export const COMPOSER_USAGE_WIDE_GAP = spacing.sm

/** One line, reset label · bar · percent, sized from the composer's free room. */
export function ComposerUsageWideMeter({
  layout,
  accessibilityLabel,
  resetsIn,
  resetsInCompact,
  percentLabel,
  readout,
  color,
  onPress
}: {
  layout: { width: number; label: 'full' | 'compact' }
  accessibilityLabel: string
  resetsIn: string
  resetsInCompact: string
  percentLabel: string
  readout: ComposerUsageMeterReadout
  color: string
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.meter,
        { width: layout.width },
        pressed && composerInputStyles.pressed
      ]}
      testID="composer-usage-meter"
    >
      <Text style={[styles.text, styles.label]} numberOfLines={1}>
        {layout.label === 'full' ? resetsIn : resetsInCompact}
      </Text>
      <ComposerUsageTrack readout={readout} color={color} wide />
      <Text style={[styles.text, styles.percent]} numberOfLines={1}>
        {percentLabel}
      </Text>
    </Pressable>
  )
}

/** The full reset label and the percent at the wide meter's size, for a hidden measuring row. */
export function ComposerUsageWideMeasure({
  resetsIn,
  percentLabel,
  onResetWidth,
  onPercentWidth
}: {
  resetsIn: string
  percentLabel: string
  onResetWidth: (width: number) => void
  onPercentWidth: (width: number) => void
}): React.JSX.Element {
  return (
    <>
      <Text
        style={[styles.text, styles.label]}
        onLayout={(event) => onResetWidth(event.nativeEvent.layout.width)}
      >
        {resetsIn}
      </Text>
      <Text
        style={[styles.text, styles.percent]}
        onLayout={(event) => onPercentWidth(event.nativeEvent.layout.width)}
      >
        {percentLabel}
      </Text>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  meter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: COMPOSER_USAGE_WIDE_GAP,
    minHeight: 32,
    borderRadius: radii.pill
  },
  text: {
    fontSize: typography.bodySize,
    lineHeight: 18,
    color: colors.textSecondary,
    flexShrink: 0,
    fontVariant: ['tabular-nums']
  },
  label: {
    color: colors.textMuted
  },
  percent: {
    fontWeight: '600',
    color: colors.textPrimary
  }
}))
