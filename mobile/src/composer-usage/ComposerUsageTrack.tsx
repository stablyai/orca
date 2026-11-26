import { View } from 'react-native'
import { colors, radii } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import type { ComposerUsageMeterReadout } from './composer-usage-meter-readout'

export const TRACK_MIN_WIDTH = 24

/** The usage bar, filled to the readout in its pace colour; thicker in the wide meter. */
export function ComposerUsageTrack({
  readout,
  color,
  wide = false
}: {
  readout: ComposerUsageMeterReadout
  color: string
  wide?: boolean
}): React.JSX.Element {
  return (
    <View style={[styles.track, wide && styles.wideTrack]}>
      <View style={[styles.fill, { width: `${readout.shown}%`, backgroundColor: color }]} />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  track: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: TRACK_MIN_WIDTH,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.translucentFill,
    overflow: 'hidden'
  },
  wideTrack: {
    height: 6
  },
  fill: {
    height: '100%',
    borderRadius: radii.pill
  }
}))
