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
        {samples.map((value, index) => {
          const latest = index === samples.length - 1
          return (
            <View key={index} style={styles.sparkTrack}>
              <View
                style={[
                  styles.sparkFill,
                  {
                    height: `${clampPercent(value)}%`,
                    backgroundColor: latest ? usageBandColor(value) : colors.textMuted
                  }
                ]}
              />
            </View>
          )
        })}
      </View>
    </View>
  )
}

export function CoreBars({ cores }: { cores: readonly { percent: number | null }[] }) {
  useMobileColorScheme()
  if (cores.length === 0) {
    return null
  }
  return (
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
