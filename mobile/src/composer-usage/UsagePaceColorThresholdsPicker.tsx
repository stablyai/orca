import { Pressable, Text, View } from 'react-native'
import { Minus, Plus } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { triggerSelection } from '../platform/haptics/haptics'
import { concentricRadius, feedback, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import {
  updateGreenPaceThreshold,
  updateYellowPaceThreshold,
  USAGE_PACE_THRESHOLD_MAX,
  USAGE_PACE_THRESHOLD_MIN
} from './usage-pace-color'
import {
  isDefaultUsagePaceColorThresholds,
  resetUsagePaceColorThresholds,
  setUsagePaceColorThresholds,
  useUsagePaceColorThresholds
} from './usage-pace-color-preference'

function ThresholdStepper({
  label,
  dotColor,
  value,
  onChange,
  decrementLabel,
  incrementLabel,
  testIDPrefix
}: {
  label: string
  dotColor: string
  value: number
  onChange: (next: number) => void
  decrementLabel: string
  incrementLabel: string
  testIDPrefix: string
}): React.JSX.Element {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const canDecrement = value > USAGE_PACE_THRESHOLD_MIN
  const canIncrement = value < USAGE_PACE_THRESHOLD_MAX
  return (
    <View style={styles.stepperRow}>
      <View style={styles.labelGroup}>
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
        <Text style={styles.stepperLabel} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <View style={styles.stepperControl}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={decrementLabel}
          disabled={!canDecrement}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 4 }}
          onPress={() => {
            triggerSelection()
            onChange(value - 1)
          }}
          style={({ pressed }) => [
            styles.stepButton,
            !canDecrement && styles.stepButtonDisabled,
            pressed && canDecrement && styles.stepButtonPressed
          ]}
          testID={`${testIDPrefix}-dec`}
        >
          <Minus size={14} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
        <Text
          style={styles.value}
          accessibilityLabel={`+${value}%`}
          testID={`${testIDPrefix}-value`}
        >
          {`+${value}%`}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={incrementLabel}
          disabled={!canIncrement}
          hitSlop={{ top: 6, bottom: 6, left: 4, right: 6 }}
          onPress={() => {
            triggerSelection()
            onChange(value + 1)
          }}
          style={({ pressed }) => [
            styles.stepButton,
            !canIncrement && styles.stepButtonDisabled,
            pressed && canIncrement && styles.stepButtonPressed
          ]}
          testID={`${testIDPrefix}-inc`}
        >
          <Plus size={14} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
      </View>
    </View>
  )
}

/** Configures the green and yellow over-pace thresholds for the composer meter and usage pop-up. */
export function UsagePaceColorThresholdsPicker({
  inSettings = false
}: {
  inSettings?: boolean
}): React.JSX.Element {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const thresholds = useUsagePaceColorThresholds()
  const isDefault = isDefaultUsagePaceColorThresholds(thresholds)
  const { greenMaxOverPacePct: green, yellowMaxOverPacePct: yellow } = thresholds
  const caption =
    yellow > green
      ? t(
          'composerUsage.paceColors.summary',
          'Green ≤ +{{green}}% · Yellow ≤ +{{yellow}}% · Red > +{{yellow}}% over pace',
          { green, yellow }
        )
      : t(
          'composerUsage.paceColors.summaryNoYellow',
          'Green ≤ +{{green}}% · Red > +{{green}}% over pace',
          { green }
        )

  return (
    <View
      style={[styles.container, inSettings && styles.settingsContainer]}
      testID="usage-pace-color-thresholds"
    >
      <View style={styles.headerRow}>
        <Text style={styles.title}>{t('composerUsage.paceColors.label', 'Pace colors')}</Text>
        {!isDefault ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(
              'composerUsage.paceColors.resetHint',
              'Reset pace color thresholds to defaults'
            )}
            hitSlop={8}
            onPress={() => {
              triggerSelection()
              resetUsagePaceColorThresholds()
            }}
            style={({ pressed }) => [pressed && styles.stepButtonPressed]}
            testID="pace-threshold-reset"
          >
            <Text style={styles.resetText}>{t('composerUsage.paceColors.reset', 'Reset')}</Text>
          </Pressable>
        ) : null}
      </View>

      <ThresholdStepper
        label={t('composerUsage.paceColors.greenUpTo', 'Green up to')}
        dotColor={colors.statusGreen}
        value={green}
        onChange={(next) => setUsagePaceColorThresholds(updateGreenPaceThreshold(thresholds, next))}
        decrementLabel={t('composerUsage.paceColors.greenDec', 'Decrease green pace threshold')}
        incrementLabel={t('composerUsage.paceColors.greenInc', 'Increase green pace threshold')}
        testIDPrefix="pace-threshold-green"
      />

      <ThresholdStepper
        label={t('composerUsage.paceColors.yellowUpTo', 'Yellow up to')}
        dotColor={colors.statusAmber}
        value={yellow}
        onChange={(next) =>
          setUsagePaceColorThresholds(updateYellowPaceThreshold(thresholds, next))
        }
        decrementLabel={t('composerUsage.paceColors.yellowDec', 'Decrease yellow pace threshold')}
        incrementLabel={t('composerUsage.paceColors.yellowInc', 'Increase yellow pace threshold')}
        testIDPrefix="pace-threshold-yellow"
      />

      <Text style={styles.caption} testID="pace-threshold-summary">
        {caption}
      </Text>
    </View>
  )
}

const STEPPER_INSET = 3

const stylesSheet = themedStyleSheet((colors) => ({
  container: {
    gap: spacing.sm,
    paddingVertical: spacing.md
  },
  settingsContainer: {
    paddingHorizontal: spacing.md + 2
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  title: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  resetText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accentBlue
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  labelGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 1
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: radii.pill
  },
  stepperLabel: {
    fontSize: 14,
    color: colors.textSecondary,
    flexShrink: 1
  },
  stepperControl: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgBase,
    borderRadius: radii.control,
    padding: STEPPER_INSET,
    gap: spacing.xs
  },
  stepButton: {
    width: 32,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: concentricRadius(radii.control, STEPPER_INSET),
    backgroundColor: colors.bgRaised
  },
  stepButtonDisabled: {
    opacity: feedback.disabledOpacity
  },
  stepButtonPressed: {
    opacity: feedback.pressedOpacity
  },
  value: {
    minWidth: 44,
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums']
  },
  caption: {
    fontSize: typography.metaSize,
    lineHeight: 16,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  }
}))
