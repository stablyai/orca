import { useId } from 'react'
import { StyleSheet, View } from 'react-native'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { spacing } from '../../theme/mobile-theme'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'

export function MobileEdgeFade({
  edge,
  size = spacing.lg,
  color
}: {
  edge: 'top' | 'bottom' | 'left' | 'right'
  size?: number
  /** The surface it fades into; the panel's by default. */
  color?: string
}): React.JSX.Element {
  const colors = useMobileColors()
  const id = `edge-fade-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const horizontal = edge === 'left' || edge === 'right'
  const start = edge === 'top' || edge === 'left'
  const surface = color ?? colors.bgPanel
  return (
    <View
      pointerEvents="none"
      style={[
        styles.fade,
        horizontal ? styles.horizontal : styles.vertical,
        styles[edge],
        horizontal ? { width: size } : { height: size }
      ]}
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient
            id={id}
            x1="0"
            y1="0"
            x2={horizontal ? '1' : '0'}
            y2={horizontal ? '0' : '1'}
          >
            <Stop offset="0" stopColor={surface} stopOpacity={start ? 1 : 0} />
            <Stop offset="1" stopColor={surface} stopOpacity={start ? 0 : 1} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  )
}

const styles = StyleSheet.create({
  fade: { position: 'absolute' },
  horizontal: { top: 0, bottom: 0 },
  vertical: { left: 0, right: 0 },
  left: { left: 0 },
  right: { right: 0 },
  top: { top: 0 },
  bottom: { bottom: 0 }
})
