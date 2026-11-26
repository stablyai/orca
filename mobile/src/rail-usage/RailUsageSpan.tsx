import { createContext, type ReactNode } from 'react'
import { View, useWindowDimensions } from 'react-native'
import { DUO_STATUS_RING_DIAMETER } from '../layout/duo-status-row'
import { useSideRailStrip } from '../layout/side-rail'
import type { BridgeSideStripFree } from '../mobile-web-shell/bridge/page-geometry/bridge-side-strip-cover'
import { spacing } from '../theme/mobile-theme'

/** A ring and its percent below it; a span shorter than this holds no ring. */
const MIN_SPAN_HEIGHT = DUO_STATUS_RING_DIAMETER + spacing.md + spacing.sm

/** Whether the rail content starts at the strip's own top, right under the status glyph's column. */
export const RailBandAtStripTopContext = createContext(true)

/** Confines rail content to one span of the strip, in window points, while a chat uses the rest. */
export function RailUsageSpan({
  span,
  children
}: {
  span: BridgeSideStripFree
  children: ReactNode
}): React.JSX.Element | null {
  const strip = useSideRailStrip()
  const windowHeight = useWindowDimensions().height
  if (strip === null) {
    return null
  }
  const top = Math.max(span.top, strip.top)
  const bottom = Math.min(span.bottom, windowHeight - strip.bottom)
  if (bottom - top < MIN_SPAN_HEIGHT) {
    return null
  }
  return (
    <View
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: top - strip.top,
        height: bottom - top
      }}
    >
      <RailBandAtStripTopContext.Provider value={top <= strip.top}>
        {children}
      </RailBandAtStripTopContext.Provider>
    </View>
  )
}
