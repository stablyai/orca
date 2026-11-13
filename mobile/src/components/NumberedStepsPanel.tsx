import { Fragment } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export type NumberedStep = { readonly id: string; readonly title: string; readonly desc: string }

/** A panel of numbered steps with hairlines between them, as on Home's pairing guide. */
export function NumberedStepsPanel(props: { steps: readonly NumberedStep[] }) {
  useMobileColorScheme()
  return (
    <View style={styles.steps}>
      {props.steps.map((step, index) => (
        <Fragment key={step.id}>
          {index > 0 ? <View style={styles.separator} /> : null}
          <View style={styles.step}>
            <View style={styles.stepNumber}>
              <Text style={styles.stepNumberText}>{index + 1}</Text>
            </View>
            <View style={styles.stepText}>
              <Text style={styles.stepTitle}>{step.title}</Text>
              <Text style={styles.stepDescription}>{step.desc}</Text>
            </View>
          </View>
        </Fragment>
      ))}
    </View>
  )
}

const STEP_NUMBER_SIZE = 26

const styles = themedStyleSheet(() => ({
  steps: { backgroundColor: colors.bgPanel, borderRadius: radii.surface, overflow: 'hidden' },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.lg + STEP_NUMBER_SIZE + 14
  },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, padding: spacing.lg },
  stepNumber: {
    width: STEP_NUMBER_SIZE,
    height: STEP_NUMBER_SIZE,
    borderRadius: radii.pill,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  stepNumberText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums']
  },
  stepText: { flex: 1, minWidth: 0 },
  stepTitle: { fontSize: 17, lineHeight: 22, color: colors.textPrimary },
  stepDescription: { fontSize: 15, lineHeight: 20, color: colors.textSecondary, marginTop: 2 }
}))
