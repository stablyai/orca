import { Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { radii } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'

/** A numbered step as a ListRow's leading mark; ticked once the step is done. */
export function ListStepMark({ n, done }: { n: number; done: boolean }) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  return (
    <View style={[styles.step, done && styles.stepDone]}>
      {done ? (
        <Check size={13} color={colors.bgBase} strokeWidth={3} />
      ) : (
        <Text style={styles.stepNumber}>{n}</Text>
      )}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  step: {
    width: 22,
    height: 22,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    // bgRaised is the group's own colour in dark; the translucent fill shows on both.
    backgroundColor: colors.translucentFill
  },
  stepDone: { backgroundColor: colors.textPrimary },
  stepNumber: { fontSize: 12, fontWeight: '600', color: colors.textSecondary }
}))
