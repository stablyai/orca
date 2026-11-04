import { useId } from 'react'
import { StyleSheet, View } from 'react-native'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export function MobileEdgeFade({
  edge,
  height = spacing.lg
}: {
  edge: 'top' | 'bottom'
  height?: number
}): React.JSX.Element {
  useMobileColorScheme()
  const id = `edge-fade-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const top = edge === 'top'
  return (
    <View pointerEvents="none" style={[styles.fade, top ? styles.top : styles.bottom, { height }]}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.bgPanel} stopOpacity={top ? 1 : 0} />
            <Stop offset="1" stopColor={colors.bgPanel} stopOpacity={top ? 0 : 1} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  )
}

const styles = StyleSheet.create({
  fade: { position: 'absolute', left: 0, right: 0 },
  top: { top: 0 },
  bottom: { bottom: 0 }
})
