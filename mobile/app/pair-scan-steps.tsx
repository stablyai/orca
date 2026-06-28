// Why: kept out of pair-scan.tsx so the screen file stays under the
// project max-lines rule. Static step list shown above the camera while
// the user is pairing their phone with a desktop.
import { StyleSheet, Text, View } from 'react-native'
import { T } from '../src/i18n/T'
import { colors, spacing, typography } from '../src/theme/mobile-theme'

export type PairScanStep = {
  number: number
  text: string
}

export const pairScanSteps: PairScanStep[] = [
  { number: 1, text: 'Open Orca on your computer' },
  { number: 2, text: 'Go to Settings → Mobile' },
  { number: 3, text: 'Scan the QR code' }
]

export function PairScanStepItem({ number, text }: PairScanStep) {
  return (
    <View style={styles.step}>
      <View style={styles.stepBadge}>
        <Text style={styles.stepNumber}>{number}</Text>
      </View>
      <T style={styles.stepText}>{text}</T>
    </View>
  )
}

const styles = StyleSheet.create({
  step: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  stepBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  stepNumber: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textSecondary
  },
  stepText: {
    fontSize: typography.bodySize,
    color: colors.textSecondary
  }
})
