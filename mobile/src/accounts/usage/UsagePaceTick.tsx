import { View } from 'react-native'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'

/** Where an even burn would put a usage bar's fill (0–100). Sits in the slot that holds the track. */
export function UsagePaceTick({ percent }: { percent: number }): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  return (
    <View
      pointerEvents="none"
      testID="usage-bar-pace-marker"
      style={[styles.tick, { left: `${Math.max(0, Math.min(100, percent))}%` }]}
    />
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  // Taller than the track so it reads over any fill colour; centred on its position.
  tick: {
    position: 'absolute',
    top: -3,
    bottom: -3,
    width: 2,
    marginLeft: -1,
    borderRadius: 1,
    backgroundColor: colors.textPrimary
  }
}))
