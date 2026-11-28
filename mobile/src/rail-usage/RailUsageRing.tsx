import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import Svg, { Line, Path } from 'react-native-svg'
import { getProviderDisplayName } from '../../../src/shared/agent-usage/display/usage-provider-windows'
import { formatUsageWindowLength, type AgentUsage } from '../composer-usage/agent-usage-provider'
import { composerUsageMeterReadout } from '../composer-usage/composer-usage-meter-readout'
import { useComposerUsageDisplay } from '../composer-usage/composer-usage-display-preference'
import { useComposerUsageWindow } from '../composer-usage/composer-usage-window-preference'
import { usagePaceMarkerPercent } from '../composer-usage/usage-window-pace'
import { usageWindowPaceColor } from '../composer-usage/usage-pace-color'
import { useUsagePaceColorThresholds } from '../composer-usage/usage-pace-color-preference'
import { usageResetLabel } from '../composer-usage/usage-reset-label'
import { UsageProviderGlyph } from '../composer-usage/usage-provider-logo'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { DUO_STATUS_RING_DIAMETER } from '../layout/duo-status-row'
import { feedback } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import { pickRailUsageWindow, railRingArc, railRingPoint } from './rail-usage-model'

// The same ring as the iOS status glyph above it.
const SIZE = DUO_STATUS_RING_DIAMETER
const STROKE = 3.5
const CENTER = SIZE / 2
const RADIUS = (SIZE - STROKE) / 2
const GLYPH_SIZE = 13
// The pace tick crosses the stroke and stops at the ring's edge.
const TICK_INNER = RADIUS - STROKE / 2 - 1
const TICK_OUTER = RADIUS + STROKE / 2
// The ring's inner chord at the reset label's lower edge (8pt below centre), ~30pt.
const RESET_LABEL_ROOM = 2 * Math.sqrt((RADIUS - STROKE / 2) ** 2 - 8 ** 2)

/** One provider's most relevant window as an arc gauge, drawn like the Duo's Wi-Fi and battery ring. */
export function RailUsageRing({
  usage,
  now,
  onPress
}: {
  usage: AgentUsage
  now: number
  onPress: () => void
}): React.JSX.Element | null {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const display = useComposerUsageDisplay()
  const choice = useComposerUsageWindow()
  const thresholds = useUsagePaceColorThresholds()
  // "3d 2h" when it fits inside the ring, else its largest unit ("3d", "5h", "40m").
  const [fullLabelWidth, setFullLabelWidth] = useState<number | null>(null)
  const entry = pickRailUsageWindow(usage.windows, choice)
  if (!entry) {
    return null
  }
  const readout = composerUsageMeterReadout(entry.window.usedPercent, display)
  const fill = usageWindowPaceColor(entry.window, now, thresholds, colors)
  const marker = usagePaceMarkerPercent(entry.window, now, display)
  const provider = getProviderDisplayName(usage.provider)
  const vars = {
    provider,
    window: formatUsageWindowLength(entry.window.windowMinutes),
    percent: readout.shown
  }
  const resetsIn = usageResetLabel(entry.window, now)
  const label =
    fullLabelWidth !== null && fullLabelWidth <= RESET_LABEL_ROOM
      ? resetsIn
      : usageResetLabel(entry.window, now, 'compact')
  const tick = marker === null ? null : marker / 100
  const tickInner = tick === null ? null : railRingPoint(CENTER, TICK_INNER, tick)
  const tickOuter = tick === null ? null : railRingPoint(CENTER, TICK_OUTER, tick)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        display === 'remaining'
          ? t(
              'composerUsage.meter.labelRemaining',
              '{{provider}} {{window}} usage: {{percent}}% left. Show details',
              vars
            )
          : t(
              'composerUsage.meter.label',
              '{{provider}} {{window}} usage: {{percent}}% used. Show details',
              vars
            )
      }
      hitSlop={{ left: 8, right: 8, top: 8, bottom: 8 }}
      onPress={onPress}
      style={({ pressed }) => [styles.ring, pressed && styles.pressed]}
      testID={`rail-usage-ring-${usage.provider}`}
    >
      <Svg width={SIZE} height={SIZE} style={styles.arc}>
        <Path
          d={railRingArc(CENTER, RADIUS, 0, 1)}
          stroke={colors.translucentFill}
          strokeWidth={STROKE}
          strokeLinecap="round"
          fill="none"
        />
        {readout.shown > 0 ? (
          <Path
            d={railRingArc(CENTER, RADIUS, 0, readout.shown / 100)}
            stroke={fill}
            strokeWidth={STROKE}
            strokeLinecap="round"
            fill="none"
          />
        ) : null}
        {tickInner && tickOuter ? (
          <Line
            x1={tickInner.x}
            y1={tickInner.y}
            x2={tickOuter.x}
            y2={tickOuter.y}
            stroke={colors.textSecondary}
            strokeWidth={1.25}
            strokeLinecap="round"
          />
        ) : null}
      </Svg>
      <View style={styles.inside} pointerEvents="none">
        <UsageProviderGlyph provider={usage.provider} size={GLYPH_SIZE} />
        <Text style={styles.window} numberOfLines={1} allowFontScaling={false}>
          {label}
        </Text>
      </View>
      <View style={styles.measure} pointerEvents="none" aria-hidden>
        <Text
          style={styles.window}
          allowFontScaling={false}
          onLayout={(event) => setFullLabelWidth(event.nativeEvent.layout.width)}
        >
          {resetsIn}
        </Text>
      </View>
      <View style={[styles.labelRow, styles.percentRow]} pointerEvents="none">
        <Text style={styles.percent} numberOfLines={1} allowFontScaling={false}>
          {readout.shown}
        </Text>
      </View>
    </Pressable>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  ring: {
    width: SIZE,
    height: SIZE,
    alignItems: 'center',
    justifyContent: 'center'
  },
  pressed: {
    opacity: feedback.pressedOpacity
  },
  arc: {
    position: 'absolute',
    top: 0,
    left: 0
  },
  labelRow: {
    position: 'absolute',
    left: -6,
    right: -6,
    alignItems: 'center'
  },
  // Logo over window label, a little above centre so the label clears the percent below.
  inside: {
    alignItems: 'center',
    marginTop: -6
  },
  // Centred on the ring's bottom edge, in the opening the arc leaves.
  percentRow: {
    top: SIZE - STROKE / 2 - 6
  },
  percent: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums']
  },
  // Zero-height and clipped, but wide, so a two-word label measures on one line without showing.
  measure: {
    position: 'absolute',
    width: 1000,
    height: 0,
    overflow: 'hidden',
    flexDirection: 'row'
  },
  window: {
    fontSize: 8,
    lineHeight: 9,
    fontWeight: '600',
    color: colors.textSecondary,
    fontVariant: ['tabular-nums'],
    // Keeps the zero-width measure from squeezing the label below its own width.
    flexShrink: 0
  }
}))
