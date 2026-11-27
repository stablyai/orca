import { View } from 'react-native'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { useMobileColorScheme, useMobileColors } from '../../theme/use-mobile-color-scheme'

/** Rows scroll out under the New tab pill through a fade to the sidebar's ground, as BottomSearchBar's do. */
export function SidebarFade({ height }: { height: number }) {
  const scheme = useMobileColorScheme()
  const colors = useMobileColors()
  const ground = scheme === 'dark' ? colors.bgPanel : colors.bgRaised
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height }}
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="sidebar-fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={ground} stopOpacity={0} />
            <Stop offset="0.7" stopColor={ground} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#sidebar-fade)" />
      </Svg>
    </View>
  )
}
