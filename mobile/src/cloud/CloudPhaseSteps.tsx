import { Check } from 'lucide-react-native'
import { ActivityIndicator, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { CloudElapsed } from './CloudElapsed'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export type CloudProgressPhase =
  | 'creating'
  | 'waking'
  | 'granting'
  | 'pairing'
  | 'connected'
  | 'delivering'

type Step = { id: CloudProgressPhase; label: string }

/** Honest progress: each real step the phone is waiting on, with the elapsed time on the live one. */
export function CloudPhaseSteps(props: {
  phase: CloudProgressPhase
  /** When the live step started; its elapsed time ticks on the live row only. */
  since: number
  /** Show the "start the agent" step (a prompt is waiting). */
  delivering: boolean
  /** Creating a new workspace replaces "wake" with "create and clone". */
  creating?: boolean
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const steps: Step[] = [
    props.creating
      ? { id: 'creating', label: t('cloud.step.create', 'Start the sandbox and clone the repo') }
      : { id: 'waking', label: t('cloud.step.wake', 'Wake the sandbox') },
    { id: 'granting', label: t('cloud.step.grant', 'Give this phone its own access') },
    { id: 'pairing', label: t('cloud.step.pair', 'Connect, end-to-end encrypted') },
    ...(props.delivering
      ? [
          {
            id: 'delivering' as const,
            label: t('cloud.step.deliver', 'Start the agent with your prompt')
          }
        ]
      : [])
  ]
  const order: CloudProgressPhase[] = steps.map((step) => step.id)
  // `connected` counts as past the pairing step; a reused pairing skips granting entirely.
  const currentIndex =
    props.phase === 'connected' ? order.indexOf('pairing') + 1 : order.indexOf(props.phase)
  return (
    <View
      style={styles.list}
      accessibilityRole="progressbar"
      accessibilityLabel={steps[currentIndex]?.label}
      accessibilityValue={{
        min: 0,
        max: steps.length,
        now: Math.min(currentIndex + 1, steps.length)
      }}
    >
      {steps.map((step, index) => {
        const done = index < currentIndex
        const current = index === currentIndex
        return (
          <View key={step.id} style={styles.row}>
            <View style={[styles.marker, done && styles.markerDone]}>
              {done ? (
                <Check size={12} color={colors.bgBase} strokeWidth={3} />
              ) : current ? (
                <ActivityIndicator
                  size="small"
                  color={colors.textSecondary}
                  style={styles.spinner}
                />
              ) : null}
            </View>
            <Text style={[styles.label, (done || current) && styles.labelActive]} numberOfLines={2}>
              {step.label}
            </Text>
            {current ? <CloudElapsed since={props.since} style={styles.elapsed} /> : null}
          </View>
        )
      })}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  list: { gap: spacing.sm, paddingTop: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 22 },
  marker: {
    width: 18,
    height: 18,
    borderRadius: radii.pill,
    borderWidth: 1.5,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center'
  },
  markerDone: { backgroundColor: colors.statusGreen, borderColor: colors.statusGreen },
  spinner: { transform: [{ scale: 0.7 }] },
  label: { flex: 1, fontSize: 14, color: colors.textMuted },
  labelActive: { color: colors.textPrimary },
  elapsed: { fontSize: 13, color: colors.textSecondary, fontVariant: ['tabular-nums'] }
}))
