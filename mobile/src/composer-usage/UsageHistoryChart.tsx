import { useState } from 'react'
import { View } from 'react-native'
import Svg, { Line, Path } from 'react-native-svg'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { UsageChartModel } from './usage-window-stats'

const HEIGHT = 88
// Room so the line's stroke and the now dot are not clipped at the edges.
const INSET = 3

/** Usage across the window, with the even-burn line dashed and a tick at now. */
export function UsageHistoryChart({
  model,
  color,
  accessibilityLabel
}: {
  model: UsageChartModel
  color: string
  accessibilityLabel: string
}): React.JSX.Element {
  useMobileColorScheme()
  const [width, setWidth] = useState(0)
  const span = model.endsAt - model.startsAt
  const x = (at: number): number =>
    INSET + ((at - model.startsAt) / span) * Math.max(0, width - INSET * 2)
  const y = (value: number): number => INSET + (1 - value / 100) * (HEIGHT - INSET * 2)
  const line = model.points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.at)},${y(point.value)}`)
    .join(' ')
  const first = model.points[0]
  const last = model.points.at(-1)
  const area =
    first && last ? `${line} L${x(last.at)},${y(0)} L${x(first.at)},${y(0)} Z` : undefined
  return (
    <View
      style={{ height: HEIGHT }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      testID="composer-usage-chart"
    >
      {width > 0 ? (
        <Svg width={width} height={HEIGHT}>
          <Line
            x1={INSET}
            x2={width - INSET}
            y1={y(0)}
            y2={y(0)}
            stroke={colors.borderSubtle}
            strokeWidth={1}
          />
          {model.pace ? (
            <Line
              x1={x(model.startsAt)}
              y1={y(model.pace.from)}
              x2={x(model.endsAt)}
              y2={y(model.pace.to)}
              stroke={colors.textMuted}
              strokeWidth={1}
              strokeDasharray="4 4"
            />
          ) : null}
          <Line
            x1={x(model.now)}
            x2={x(model.now)}
            y1={INSET}
            y2={y(0)}
            stroke={colors.textMuted}
            strokeOpacity={0.5}
            strokeWidth={1}
          />
          {area ? <Path d={area} fill={color} fillOpacity={0.12} /> : null}
          <Path
            d={line}
            stroke={color}
            strokeWidth={2}
            fill="none"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </Svg>
      ) : null}
    </View>
  )
}
