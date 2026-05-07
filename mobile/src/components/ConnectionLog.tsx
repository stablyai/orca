import { useEffect, useRef } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import type { ConnectionLogEntry } from '../transport/types'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

type Props = {
  entries: ConnectionLogEntry[]
  // Tag printed before the first entry so it's clear what's being logged
  // (e.g. 'Pairing' vs 'Reconnect').
  title?: string
}

const LEVEL_COLOR: Record<ConnectionLogEntry['level'], string> = {
  info: colors.textSecondary,
  success: colors.statusGreen,
  warn: colors.statusAmber,
  error: colors.statusRed
}

const LEVEL_GLYPH: Record<ConnectionLogEntry['level'], string> = {
  info: '•',
  success: '✓',
  warn: '!',
  error: '✕'
}

function formatTime(ts: number, baseTs: number): string {
  // Why: show elapsed seconds since the first entry — absolute wall-clock
  // time isn't actionable when debugging "why is connecting stuck".
  const elapsed = Math.max(0, ts - baseTs) / 1000
  if (elapsed < 10) return `+${elapsed.toFixed(2)}s`
  if (elapsed < 100) return `+${elapsed.toFixed(1)}s`
  return `+${Math.round(elapsed)}s`
}

export function ConnectionLog({ entries, title }: Props) {
  const scrollRef = useRef<ScrollView | null>(null)

  // Why: keep the latest entry visible while logs grow during a slow
  // connect. Skip on empty so the title row doesn't jump.
  useEffect(() => {
    if (entries.length === 0) return
    const id = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 16)
    return () => clearTimeout(id)
  }, [entries.length])

  if (entries.length === 0) return null
  const baseTs = entries[0]!.ts

  return (
    <View style={styles.container}>
      {title && <Text style={styles.title}>{title}</Text>}
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {entries.map((entry) => (
          <View key={entry.id} style={styles.row}>
            <Text style={styles.timestamp}>{formatTime(entry.ts, baseTs)}</Text>
            <Text style={[styles.glyph, { color: LEVEL_COLOR[entry.level] }]}>
              {LEVEL_GLYPH[entry.level]}
            </Text>
            <View style={styles.rowText}>
              <Text style={[styles.message, { color: LEVEL_COLOR[entry.level] }]}>
                {entry.message}
              </Text>
              {entry.detail && (
                <Text style={styles.detail} numberOfLines={2}>
                  {entry.detail}
                </Text>
              )}
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    maxHeight: 240,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md
  },
  title: {
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.xs
  },
  scroll: {
    maxHeight: 200
  },
  scrollContent: {
    gap: 6
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm
  },
  timestamp: {
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    color: colors.textMuted,
    width: 52,
    paddingTop: 1
  },
  glyph: {
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    width: 12,
    textAlign: 'center',
    paddingTop: 1
  },
  rowText: {
    flex: 1
  },
  message: {
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: 16
  },
  detail: {
    fontFamily: typography.monoFamily,
    fontSize: 11,
    color: colors.textMuted,
    lineHeight: 14,
    marginTop: 1
  }
})
