import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import type { RuntimeWorktreeAgentContextPressure } from '../../../src/shared/runtime-types'
import { colors } from '../theme/mobile-theme'
import { formatContextPressurePercent } from '../worktree/context-pressure-display'
import { CONTEXT_PRESSURE_COPY } from './context-pressure-copy'

// Mobile exposes exact pressure details on press instead of hover.
const LEVEL_COLORS: Record<RuntimeWorktreeAgentContextPressure['level'], string> = {
  ok: colors.statusGreen,
  warning: colors.statusAmber,
  critical: colors.statusRed
}

const numberFormat = new Intl.NumberFormat()

export function ContextPressureDot({
  pressure
}: {
  pressure: RuntimeWorktreeAgentContextPressure
}) {
  const copy = CONTEXT_PRESSURE_COPY
  const percent = formatContextPressurePercent(pressure.usedPercent)
  const levelLabel = copy.levels[pressure.level]
  const approximate = pressure.usedTokensSource === 'derived-percent' ? `${copy.approximate} ` : ''
  const tokenDetail =
    pressure.usedTokens !== undefined && pressure.limitTokens !== undefined
      ? `${approximate}${numberFormat.format(pressure.usedTokens)} / ${numberFormat.format(pressure.limitTokens)} ${copy.tokens}`
      : null
  // Guarded lookup: an unknown limitSource from a newer desktop must not print "undefined".
  const sourceLabel = pressure.limitSource ? copy.limitSources[pressure.limitSource] : undefined
  const sourceDetail = sourceLabel ? `${copy.effectiveLimit}: ${sourceLabel}` : null
  const detail = [tokenDetail ?? `${percent} ${copy.used}`, sourceDetail, levelLabel]
    .filter(Boolean)
    .join('. ')
  return (
    <Pressable
      style={styles.wrapper}
      accessibilityRole="button"
      accessibilityLabel={`${copy.windowLabel} ${detail}`}
      accessibilityHint={copy.hint}
      onPress={(event) => {
        event.stopPropagation()
        Alert.alert(copy.title, detail)
      }}
      hitSlop={8}
    >
      <View style={styles.dotFrame}>
        <View
          style={[
            styles.dot,
            pressure.level === 'warning' && styles.warningDot,
            pressure.level === 'critical' && styles.criticalDot,
            { backgroundColor: LEVEL_COLORS[pressure.level] ?? colors.textMuted }
          ]}
        />
      </View>
      <Text style={styles.percent}>{percent}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  wrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3
  },
  dotFrame: {
    width: 8,
    height: 8,
    alignItems: 'center',
    justifyContent: 'center'
  },
  warningDot: {
    borderRadius: 1,
    transform: [{ rotate: '45deg' }]
  },
  criticalDot: {
    borderRadius: 0
  },
  percent: {
    fontSize: 10,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  }
})
