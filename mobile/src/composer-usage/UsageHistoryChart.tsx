import { useState } from 'react'
import { Platform, Text, View } from 'react-native'
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg'
import { formatResetDuration } from '../../../src/shared/agent-usage/rate-limits/rate-limit-reset-format'
import { intlLocaleFor } from '../i18n/ui-intl-locale'
import { useMobileTranslation, useMobileUiLocale } from '../i18n/use-mobile-translation'
import { spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import type { UsageChartModel, UsageChartPoint } from './usage-window-stats'

const PLOT_HEIGHT = 112
const TOP = 16
const AXIS_GUTTER = 34
const RIGHT = 4
const X_LABELS = 16
const HEIGHT = TOP + PLOT_HEIGHT + X_LABELS
const LABEL_SIZE = typography.metaSize
// A middle time label only once three dates fit side by side.
const MID_LABEL_MIN_WIDTH = 380
const DAY_MS = 24 * 60 * 60_000
// SVG text on the web page otherwise falls back to the browser's serif font.
const LABEL_FONT =
  Platform.OS === 'web' ? 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' : undefined

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

/** Times on one day read as clock times; a window past midnight names the day, a long one the date. */
function axisTimeFormat(startsAt: number, endsAt: number, locale: string): (at: number) => string {
  const options: Intl.DateTimeFormatOptions = sameDay(startsAt, endsAt - 1)
    ? { hour: 'numeric', minute: '2-digit' }
    : endsAt - startsAt <= 2 * DAY_MS
      ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
      : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
  const format = new Intl.DateTimeFormat(locale, options)
  return (at) => format.format(new Date(at))
}

/** Used (or left) percent across the whole window, from its last reset to its next. Observed
 *  readings draw as a solid line; stretches without recorded readings (from reset to the first
 *  reading, across recording gaps, or from reset to now with no history yet) extrapolate linearly
 *  as a dashed line in the series color. The even-burn reference is dashed gray and now is marked. */
export function UsageHistoryChart({
  model,
  color,
  seriesLabel,
  accessibilityLabel
}: {
  model: UsageChartModel
  color: string
  seriesLabel: string
  accessibilityLabel: string
}): React.JSX.Element {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const locale = intlLocaleFor(useMobileUiLocale())
  const [width, setWidth] = useState(0)
  const span = model.endsAt - model.startsAt
  const plotWidth = Math.max(0, width - AXIS_GUTTER - RIGHT)
  const x = (at: number): number => AXIS_GUTTER + ((at - model.startsAt) / span) * plotWidth
  const y = (value: number): number => TOP + (1 - value / 100) * PLOT_HEIGHT
  const formatTime = axisTimeFormat(model.startsAt, model.endsAt, locale)
  const nowX = x(model.now)
  const nowAnchor =
    nowX - AXIS_GUTTER < 24 ? 'start' : x(model.endsAt) - nowX < 24 ? 'end' : 'middle'
  const caption =
    model.firstAt !== null
      ? (() => {
          const historyMs = (model.lastRecordedAt ?? model.firstAt) - model.firstAt
          return t('composerUsage.chart.historySince', 'History since {{when}} · {{duration}}', {
            when: new Date(model.firstAt).toLocaleString(locale, {
              weekday: 'short',
              hour: 'numeric',
              minute: '2-digit'
            }),
            duration:
              historyMs < 60_000
                ? t('composerUsage.chart.oneReading', 'one reading')
                : formatResetDuration(historyMs)
          })
        })()
      : t('composerUsage.chart.extrapolatedOnly', 'No readings yet · extrapolated from reset')
  const hasExtrapolated =
    width > 0
      ? model.extrapolated.some((segment) => x(segment.to.at) - x(segment.from.at) >= 1)
      : model.extrapolated.length > 0
  const dotMap = new Map<number, UsageChartPoint>()
  for (const run of model.runs) {
    const start = run[0]
    const end = run.at(-1)
    if (start) {
      dotMap.set(start.at, start)
    }
    if (end) {
      dotMap.set(end.at, end)
    }
  }
  dotMap.set(model.current.at, model.current)
  const dots = [...dotMap.values()]
  return (
    <View style={styles.wrap}>
      <Text style={styles.caption} testID="composer-usage-chart-history">
        {caption}
      </Text>
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
            {[0, 50, 100].map((value) => (
              <Line
                key={`grid-${value}`}
                x1={AXIS_GUTTER}
                x2={width - RIGHT}
                y1={y(value)}
                y2={y(value)}
                stroke={colors.textMuted}
                strokeOpacity={value === 0 ? 0.5 : 0.25}
                strokeWidth={1}
                strokeDasharray={value === 50 ? '2 3' : undefined}
              />
            ))}
            {[0, 50, 100].map((value) => (
              <SvgText
                key={`grid-label-${value}`}
                x={AXIS_GUTTER - 6}
                y={y(value) + LABEL_SIZE / 3}
                fontSize={LABEL_SIZE}
                fontFamily={LABEL_FONT}
                fill={colors.textMuted}
                textAnchor="end"
              >
                {`${value}%`}
              </SvgText>
            ))}
            {model.pace ? (
              <Line
                x1={x(model.startsAt)}
                y1={y(model.pace.from)}
                x2={x(model.endsAt)}
                y2={y(model.pace.to)}
                stroke={colors.textSecondary}
                strokeOpacity={0.7}
                strokeWidth={1}
                strokeDasharray="4 4"
              />
            ) : null}
            {model.extrapolated.map((segment) => (
              <Path
                key={`extrapolated-area-${segment.from.at}-${segment.to.at}`}
                d={`M${x(segment.from.at)},${y(segment.from.value)} L${x(segment.to.at)},${y(segment.to.value)} L${x(segment.to.at)},${y(0)} L${x(segment.from.at)},${y(0)} Z`}
                fill={color}
                fillOpacity={0.07}
              />
            ))}
            {model.runs.map((run) => {
              const start = run[0]
              const end = run.at(-1)
              if (!start || !end || run.length < 2) {
                return null
              }
              const line = run
                .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.at)},${y(p.value)}`)
                .join(' ')
              return (
                <Path
                  key={`area-${start.at}`}
                  d={`${line} L${x(end.at)},${y(0)} L${x(start.at)},${y(0)} Z`}
                  fill={color}
                  fillOpacity={0.14}
                />
              )
            })}
            {model.extrapolated.map((segment) => (
              <Line
                key={`extrapolated-line-${segment.from.at}-${segment.to.at}`}
                x1={x(segment.from.at)}
                y1={y(segment.from.value)}
                x2={x(segment.to.at)}
                y2={y(segment.to.value)}
                stroke={color}
                strokeOpacity={0.85}
                strokeWidth={2}
                strokeDasharray="5 4"
              />
            ))}
            {model.runs.map((run) => {
              const start = run[0]
              if (!start || run.length < 2) {
                return null
              }
              return (
                <Path
                  key={`line-${start.at}`}
                  d={run.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.at)},${y(p.value)}`).join(' ')}
                  stroke={color}
                  strokeWidth={2}
                  fill="none"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )
            })}
            <Line
              x1={nowX}
              x2={nowX}
              y1={TOP - 2}
              y2={y(0)}
              stroke={colors.textSecondary}
              strokeWidth={1}
            />
            <SvgText
              x={nowX}
              y={TOP - 5}
              fontSize={LABEL_SIZE}
              fontFamily={LABEL_FONT}
              fontWeight="600"
              fill={colors.textSecondary}
              textAnchor={nowAnchor}
            >
              {t('composerUsage.chart.now', 'Now')}
            </SvgText>
            {dots.map((point) => (
              <Circle
                key={`dot-${point.at}`}
                cx={x(point.at)}
                cy={y(point.value)}
                r={point.at === model.firstAt ? 4 : 3}
                fill={color}
                stroke={colors.sheetSurface}
                strokeWidth={1.5}
              />
            ))}
            <SvgText
              x={x(model.startsAt)}
              y={HEIGHT - 3}
              fontSize={LABEL_SIZE}
              fontFamily={LABEL_FONT}
              fill={colors.textMuted}
              textAnchor="start"
            >
              {formatTime(model.startsAt)}
            </SvgText>
            {plotWidth >= MID_LABEL_MIN_WIDTH ? (
              <SvgText
                x={x(model.startsAt + span / 2)}
                y={HEIGHT - 3}
                fontSize={LABEL_SIZE}
                fontFamily={LABEL_FONT}
                fill={colors.textMuted}
                textAnchor="middle"
              >
                {formatTime(model.startsAt + span / 2)}
              </SvgText>
            ) : null}
            <SvgText
              x={x(model.endsAt)}
              y={HEIGHT - 3}
              fontSize={LABEL_SIZE}
              fontFamily={LABEL_FONT}
              fill={colors.textMuted}
              textAnchor="end"
            >
              {formatTime(model.endsAt)}
            </SvgText>
          </Svg>
        ) : null}
      </View>
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.swatchLine, { backgroundColor: color }]} />
          <Text style={styles.legendText}>{seriesLabel}</Text>
        </View>
        {hasExtrapolated ? (
          <View style={styles.legendItem}>
            <Svg width={14} height={4}>
              <Line
                x1={0}
                y1={2}
                x2={14}
                y2={2}
                stroke={color}
                strokeOpacity={0.85}
                strokeWidth={2}
                strokeDasharray="3 2"
              />
            </Svg>
            <Text style={styles.legendText}>
              {t('composerUsage.chart.legendExtrapolated', 'Extrapolated')}
            </Text>
          </View>
        ) : null}
        {model.pace ? (
          <View style={styles.legendItem}>
            <View style={styles.swatchDashed} />
            <Text style={styles.legendText}>
              {t('composerUsage.chart.legendPace', 'Even pace to reset')}
            </Text>
          </View>
        ) : null}
        {model.firstAt !== null ? (
          <View style={styles.legendItem}>
            <View style={[styles.swatchDot, { backgroundColor: color }]} />
            <Text style={styles.legendText}>
              {t('composerUsage.chart.legendFirst', 'First reading')}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  wrap: {
    gap: spacing.xs
  },
  caption: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: spacing.md,
    rowGap: spacing.xxs
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  legendText: {
    fontSize: typography.metaSize,
    color: colors.textSecondary
  },
  swatchLine: {
    width: 14,
    height: 2,
    borderRadius: 1
  },
  swatchDashed: {
    width: 14,
    height: 0,
    borderTopWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.textSecondary
  },
  swatchDot: {
    width: 8,
    height: 8,
    borderRadius: 4
  }
}))
