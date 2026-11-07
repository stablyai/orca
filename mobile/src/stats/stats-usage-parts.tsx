import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { formatCost, formatTokens, type UsageBreakdownRow } from './usage-report-model'

// One visual system for Stats & Usage: every section is an uppercase heading over one panel card,
// numbers sit in hairline-split metric strips, lists use one row shape.

export function UsageSection(props: {
  title: string
  accessory?: ReactNode
  /** The column's first section sits flush under the title, level with the right column's first card. */
  first?: boolean
  children: ReactNode
}) {
  useMobileColorScheme()
  return (
    <View style={!props.first && styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionHeading}>{props.title}</Text>
        {props.accessory}
      </View>
      <View style={styles.card}>{props.children}</View>
    </View>
  )
}

/** Full-bleed hairline between blocks inside a section card. */
export function CardDivider() {
  useMobileColorScheme()
  return <View style={styles.divider} />
}

export function MetricStrip(props: { items: { label: string; value: string }[] }) {
  useMobileColorScheme()
  return (
    <View style={styles.metricRow}>
      {props.items.map((item, index) => (
        <View key={item.label} style={[styles.metricCell, index > 0 && styles.metricDivider]}>
          <Text style={styles.metricValue} numberOfLines={1} adjustsFontSizeToFit>
            {item.value}
          </Text>
          <Text style={styles.metricLabel} numberOfLines={1}>
            {item.label}
          </Text>
        </View>
      ))}
    </View>
  )
}

export function Segmented(props: {
  items: { id: string; label: string }[]
  selected: string
  onSelect: (id: string) => void
}) {
  useMobileColorScheme()
  return (
    <View style={styles.segmented}>
      {props.items.map((item) => {
        const active = item.id === props.selected
        return (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={[styles.segment, active && styles.segmentActive]}
            onPress={() => props.onSelect(item.id)}
          >
            <Text
              style={[styles.segmentLabel, active && styles.segmentLabelActive]}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {item.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function BlockLabel(props: { children: string }) {
  useMobileColorScheme()
  return <Text style={styles.blockLabel}>{props.children}</Text>
}

export function DailyBars(props: {
  days: { day: string; segments: { color: string; value: number }[] }[]
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  if (props.days.length === 0) {
    return <Notice>{t('statsUsage.noActivityInRange', 'No activity in this range.')}</Notice>
  }
  const max = Math.max(1, ...props.days.map((d) => d.segments.reduce((s, x) => s + x.value, 0)))
  return (
    <View>
      <View style={styles.bars}>
        {props.days.map((entry) => (
          <View key={entry.day} style={styles.barSlot}>
            {entry.segments.map((segment, index) =>
              segment.value > 0 ? (
                <View
                  key={index}
                  style={{
                    height: `${(segment.value / max) * 100}%`,
                    backgroundColor: segment.color
                  }}
                />
              ) : null
            )}
          </View>
        ))}
      </View>
      <View style={styles.barAxis}>
        <Text style={styles.caption}>{formatDay(props.days[0]!.day)}</Text>
        <Text style={styles.caption}>{formatDay(props.days[props.days.length - 1]!.day)}</Text>
      </View>
    </View>
  )
}

export function Legend(props: { items: { color: string; label: string }[] }) {
  useMobileColorScheme()
  return (
    <View style={styles.legend}>
      {props.items.map((item) => (
        <View key={item.label} style={styles.legendItem}>
          <View style={[styles.dot, { backgroundColor: item.color }]} />
          <Text style={styles.caption}>{item.label}</Text>
        </View>
      ))}
    </View>
  )
}

export function MixBar(props: { parts: { color: string; value: number }[] }) {
  useMobileColorScheme()
  return (
    <View style={styles.mixBar}>
      {props.parts.map((part) =>
        part.value > 0 ? (
          <View key={part.color} style={{ flex: part.value, backgroundColor: part.color }} />
        ) : null
      )}
    </View>
  )
}

/** The one list-row shape: label (+ detail line) on the left, value on the right, optional share bar. */
export function UsageRow(props: {
  label: string
  value: string
  detail?: string
  dotColor?: string
  share?: number
  first?: boolean
  onPress?: () => void
}) {
  useMobileColorScheme()
  const body = (
    <>
      <View style={styles.rowLine}>
        {props.dotColor ? <View style={[styles.dot, { backgroundColor: props.dotColor }]} /> : null}
        <View style={styles.rowText}>
          <Text style={styles.rowLabel} numberOfLines={1}>
            {props.label}
          </Text>
          {props.detail ? (
            <Text style={styles.caption} numberOfLines={1}>
              {props.detail}
            </Text>
          ) : null}
        </View>
        <Text style={styles.rowValue}>{props.value}</Text>
      </View>
      {props.share !== undefined ? (
        <View style={styles.shareTrack}>
          <View
            style={[
              styles.shareFill,
              {
                width: `${Math.max(props.share, 0.01) * 100}%`,
                backgroundColor: props.dotColor ?? colors.accentBlue
              }
            ]}
          />
        </View>
      ) : null}
    </>
  )
  const style = [styles.row, !props.first && styles.rowBorder]
  return props.onPress ? (
    <Pressable style={style} onPress={props.onPress}>
      {body}
    </Pressable>
  ) : (
    <View style={style}>{body}</View>
  )
}

export function Notice(props: { children: string }) {
  useMobileColorScheme()
  return <Text style={styles.notice}>{props.children}</Text>
}

const MIX_COLORS = { input: '#38bdf8', output: '#34d399', cache: '#f59e0b' }

export function TokenMix(props: { input: number; output: number; cache: number }) {
  const t = useMobileTranslation()
  return (
    <>
      <BlockLabel>{t('statsUsage.tokenMix', 'Token mix')}</BlockLabel>
      <MixBar
        parts={[
          { color: MIX_COLORS.input, value: props.input },
          { color: MIX_COLORS.output, value: props.output },
          { color: MIX_COLORS.cache, value: props.cache }
        ]}
      />
      <Legend
        items={[
          {
            color: MIX_COLORS.input,
            label: t('statsUsage.mixInput', 'Input {{tokens}}', {
              tokens: formatTokens(props.input)
            })
          },
          {
            color: MIX_COLORS.output,
            label: t('statsUsage.mixOutput', 'Output {{tokens}}', {
              tokens: formatTokens(props.output)
            })
          },
          {
            color: MIX_COLORS.cache,
            label: t('statsUsage.mixCache', 'Cache {{tokens}}', {
              tokens: formatTokens(props.cache)
            })
          }
        ]}
      />
    </>
  )
}

export function BreakdownSection(props: {
  title: string
  rows: UsageBreakdownRow[]
  color: string
}) {
  if (props.rows.length === 0) {
    return null
  }
  const max = Math.max(1, ...props.rows.map((row) => row.totalTokens))
  return (
    <UsageSection title={props.title}>
      <View style={{ marginVertical: -8 }}>
        {props.rows.slice(0, 8).map((row, index) => (
          <UsageRow
            key={row.key || index}
            first={index === 0}
            label={row.label || row.key}
            value={`${formatTokens(row.totalTokens)} · ${formatCost(row.costUsd)}`}
            dotColor={props.color}
            share={row.totalTokens / max}
          />
        ))}
      </View>
    </UsageSection>
  )
}

function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00`)
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString(getUiIntlLocale(), { month: 'short', day: 'numeric' })
}

export function formatSessionTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(getUiIntlLocale(), { month: 'short', day: 'numeric' })
}

const styles = themedStyleSheet(() => ({
  section: { marginTop: spacing.lg },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
    paddingLeft: spacing.xs
  },
  sectionHeading: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6
  },
  card: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
    padding: spacing.md,
    gap: spacing.md
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: -spacing.md
  },
  metricRow: { flexDirection: 'row' },
  metricCell: { flex: 1, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  metricDivider: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.borderSubtle
  },
  metricValue: { color: colors.textPrimary, fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  metricLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '500', marginTop: 2 },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.bgBase,
    borderRadius: radii.control,
    padding: 2,
    gap: 2
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.tile
  },
  segmentActive: { backgroundColor: colors.bgRaised },
  segmentLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '500' },
  segmentLabelActive: { color: colors.textPrimary },
  blockLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '500',
    marginBottom: -spacing.xs
  },
  bars: { height: 96, flexDirection: 'row', alignItems: 'flex-end', gap: 1 },
  barSlot: {
    flex: 1,
    height: '100%',
    flexDirection: 'column-reverse',
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
    overflow: 'hidden'
  },
  barAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  caption: { color: colors.textMuted, fontSize: 11 },
  mixBar: { flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  row: { paddingVertical: spacing.sm, gap: 6 },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
  rowLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowLabel: { color: colors.textPrimary, fontSize: 13, fontWeight: '500' },
  rowValue: { color: colors.textSecondary, fontSize: 12, fontVariant: ['tabular-nums'] },
  shareTrack: { height: 3, borderRadius: 2, backgroundColor: colors.bgRaised },
  shareFill: { height: 3, borderRadius: 2 },
  notice: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 }
}))
