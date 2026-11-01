import { Text, View } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import { usageBandColor } from '../components/AccountUsage'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { RING_SIZE, styles } from './mobile-resources-screen-styles'

const RING_STROKE = 7

export function CpuRing({ percent }: { percent: number | null }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const radius = (RING_SIZE - RING_STROKE) / 2
  const circumference = 2 * Math.PI * radius
  const shown = percent !== null && percent > 0
  const label =
    percent === null
      ? t('resources.screen.cpuUnavailable', 'CPU usage unavailable')
      : t('resources.screen.cpuPercent', 'CPU {{percent}} percent', { percent })
  return (
    <View accessible accessibilityLabel={label} style={styles.ringBox}>
      <Svg width={RING_SIZE} height={RING_SIZE} accessibilityElementsHidden>
        <Circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={radius}
          stroke={colors.bgRaised}
          strokeWidth={RING_STROKE}
          fill="none"
        />
        {shown ? (
          <Circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={radius}
            stroke={usageBandColor(percent)}
            strokeWidth={RING_STROKE}
            fill="none"
            strokeDasharray={[(percent / 100) * circumference, circumference]}
            strokeLinecap="round"
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          />
        ) : null}
      </Svg>
      <Text
        style={styles.ringPercent}
        accessibilityElementsHidden
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.5}
      >
        {percent === null ? '—' : `${percent}%`}
      </Text>
    </View>
  )
}

export function CpuSparkline({ samples }: { samples: readonly number[] }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  if (samples.length === 0) {
    return null
  }
  return (
    <View
      accessible
      accessibilityLabel={t('resources.screen.cpuRecent', 'CPU over recent samples')}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.sparkline}
      >
        {samples.map((value, index) => (
          <View key={index} style={styles.sparkTrack}>
            <View
              style={[
                styles.sparkFill,
                {
                  height: `${clampPercent(value)}%`,
                  backgroundColor: usageBandColor(value)
                }
              ]}
            />
          </View>
        ))}
      </View>
    </View>
  )
}

export function CoreBars({ cores }: { cores: readonly { percent: number | null }[] }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  if (cores.length === 0) {
    return null
  }
  return (
    <View style={styles.coreBlock}>
      <Text style={styles.meta}>{t('resources.screen.coresHeading', 'Cores')}</Text>
      <View
        style={styles.cores}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {cores.map((core, index) => (
          <View key={index} style={styles.coreTrack}>
            <View
              style={[
                styles.coreFill,
                {
                  width: `${core.percent === null ? 0 : clampPercent(core.percent)}%`,
                  backgroundColor: usageBandColor(core.percent)
                }
              ]}
            />
          </View>
        ))}
      </View>
      <View style={styles.legend}>
        <BandLegend percent={0} label={t('resources.screen.bandLow', 'Under 60%')} />
        <BandLegend percent={60} label={t('resources.screen.bandMid', '60–79%')} />
        <BandLegend percent={80} label={t('resources.screen.bandHigh', '80%+')} />
      </View>
    </View>
  )
}

function BandLegend({ percent, label }: { percent: number; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendSwatch, { backgroundColor: usageBandColor(percent) }]} />
      <Text style={styles.meta}>{label}</Text>
    </View>
  )
}

export function ResourceMeter({
  label,
  caption,
  usedPercent,
  accessibilityLabel,
  quiet = false
}: {
  label?: string
  caption: string
  usedPercent: number
  accessibilityLabel: string
  quiet?: boolean
}) {
  useMobileColorScheme()
  const rounded = Math.round(clampPercent(usedPercent))
  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      style={quiet ? styles.quietMeter : styles.meter}
    >
      {label !== undefined ? (
        <Text style={quiet ? styles.meta : styles.body} accessibilityElementsHidden>
          {label}
        </Text>
      ) : null}
      <View accessibilityElementsHidden style={styles.meterRow}>
        <View style={styles.track}>
          <View
            style={[
              styles.fill,
              { width: `${rounded}%`, backgroundColor: usageBandColor(rounded) }
            ]}
          />
        </View>
        <Text style={quiet ? styles.meta : styles.body}>{`${rounded}%`}</Text>
      </View>
      <Text style={quiet ? styles.meta : styles.caption} accessibilityElementsHidden>
        {caption}
      </Text>
    </View>
  )
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}
