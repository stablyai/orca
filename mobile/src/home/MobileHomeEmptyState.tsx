import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { OrcaLogo } from '../components/OrcaLogo'
import { Button } from '../components/ui/Button'
import { colors, spacing, textStyles } from '../theme/mobile-theme'

const ONBOARDING_STEPS = [
  'Open Orca on your computer, then Settings › Mobile.',
  'Scan the code it shows.',
  "That's it. Everything is encrypted end to end."
]

const STEP_BADGE = 22

/** First run: the logo, one line on what pairing gives you, three quiet steps, and "Pair a desktop". */
export function MobileHomeEmptyState(props: {
  bottomInset: number
  contentMaxWidth: number
  isWideLayout: boolean
  onPairDesktop: () => void
}) {
  const width = props.isWideLayout ? [styles.wide, { maxWidth: props.contentMaxWidth }] : null
  return (
    <View style={styles.screen}>
      {/* Scrolls because a phone in landscape is shorter than the hero and the steps together. */}
      <ScrollView contentContainerStyle={[styles.content, width]}>
        <OrcaLogo size={40} color={colors.textPrimary} />
        <Text style={styles.title} accessibilityRole="header">
          Run Orca from your phone
        </Text>
        <Text style={styles.body}>
          Pair with Orca on your computer to follow agents, answer them and start new work from
          anywhere.
        </Text>
        <View style={styles.steps}>
          {ONBOARDING_STEPS.map((step, index) => (
            <View
              key={step}
              style={styles.step}
              accessible
              accessibilityLabel={`Step ${index + 1}: ${step}`}
            >
              <View style={styles.stepBadge}>
                <Text style={styles.stepNumber}>{index + 1}</Text>
              </View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
      <View
        style={[styles.footer, { paddingBottom: Math.max(props.bottomInset, spacing.lg) }, width]}
      >
        <Button label="Pair a desktop" variant="primary" block onPress={props.onPairDesktop} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  wide: { width: '100%', alignSelf: 'center' },
  content: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 36,
    paddingVertical: spacing.xl,
    gap: spacing.md
  },
  // Kelvin's call for the first-run hero: 26/32, between title and largeTitle.
  title: {
    ...textStyles.title,
    fontSize: 26,
    lineHeight: 32,
    color: colors.textPrimary,
    textAlign: 'center',
    marginTop: spacing.sm
  },
  body: { ...textStyles.body, color: colors.textSecondary, textAlign: 'center', maxWidth: 340 },
  steps: { alignSelf: 'stretch', gap: 14, marginTop: 26 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  stepBadge: {
    width: STEP_BADGE,
    height: STEP_BADGE,
    borderRadius: STEP_BADGE / 2,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  stepNumber: {
    ...textStyles.caption,
    fontWeight: '500',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums']
  },
  stepText: { ...textStyles.callout, color: colors.textSecondary, flex: 1, minWidth: 0 },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md }
})
