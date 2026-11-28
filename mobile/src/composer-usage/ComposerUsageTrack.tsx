import { View } from 'react-native'
import { UsagePaceTick } from '../accounts/usage/UsagePaceTick'
import { radii } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import type { ComposerUsageMeterReadout } from './composer-usage-meter-readout'

export const TRACK_MIN_WIDTH = 24

/** The usage bar, filled to the readout in its pace colour. The wide bar is thicker and carries the pace tick. */
export function ComposerUsageTrack({
  readout,
  color,
  wide = false,
  paceMarkerPercent = null
}: {
  readout: ComposerUsageMeterReadout
  color: string
  wide?: boolean
  /** Where an even burn would put the fill. Wide bars only; null hides it. */
  paceMarkerPercent?: number | null
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const fill = (
    <View style={[styles.fill, { width: `${readout.shown}%`, backgroundColor: color }]} />
  )
  if (!wide) {
    return <View style={[styles.flex, styles.track]}>{fill}</View>
  }
  // The tick overhangs the track, so it sits in an unclipped slot beside it.
  return (
    <View style={[styles.flex, styles.wideSlot]}>
      <View style={[styles.track, styles.wideTrack]}>{fill}</View>
      {paceMarkerPercent != null ? <UsagePaceTick percent={paceMarkerPercent} /> : null}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  flex: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: TRACK_MIN_WIDTH
  },
  track: {
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.translucentFill,
    overflow: 'hidden'
  },
  wideSlot: {
    justifyContent: 'center'
  },
  wideTrack: {
    height: 6
  },
  fill: {
    height: '100%',
    borderRadius: radii.pill
  }
}))
