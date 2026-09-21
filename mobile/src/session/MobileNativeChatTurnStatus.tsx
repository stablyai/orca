import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import {
  formatNativeChatActiveTurnLabel,
  formatNativeChatTurnStatusLabel,
  NATIVE_CHAT_TURN_STATUS_COPY,
  nativeChatElapsedSeconds
} from '../../../src/shared/native-chat-turn-status'
import { colors, spacing, typography } from '../theme/mobile-theme'

/** Seconds tick only while a turn is actually counting, so a settled transcript
 *  holds no timers. */
function useElapsedSeconds(startedAt: number | null, counting: boolean): number {
  // Preserves the pre-stamp epoch for the frame before the turn's startedAt lands.
  const [mountedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!counting) {
      return
    }
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [counting])
  return counting ? nativeChatElapsedSeconds(startedAt, mountedAt, now) : 0
}

/** The per-turn status row. While the turn runs it is the one live indicator — a
 *  spinner beside what the provider says it is doing, else "Thinking", else
 *  "Working for 12s". It settles to a tappable "Worked for 3m 4s" that discloses
 *  the turn's tool activity. Desktop parity: `NativeChatTurnActivityLine` for the
 *  live row, `NativeChatWorkingStatus` for the settled one. */
export function MobileNativeChatTurnStatus({
  startedAt,
  thinking,
  workedSeconds,
  activityText,
  expanded = false,
  onToggleExpanded
}: {
  startedAt: number | null
  thinking: boolean
  workedSeconds?: number | null
  /** Provider activity copy for a live turn; outranks the other two labels. */
  activityText?: string | null
  expanded?: boolean
  onToggleExpanded?: () => void
}): React.JSX.Element {
  const settled = workedSeconds != null
  const counting = !settled && !thinking && !activityText?.trim()
  const elapsedSeconds = useElapsedSeconds(startedAt, counting)
  const label = settled
    ? formatNativeChatTurnStatusLabel({ thinking, workedSeconds, elapsedSeconds })
    : formatNativeChatActiveTurnLabel({ activityText, thinking, elapsedSeconds })

  if (settled && onToggleExpanded) {
    return (
      <Pressable
        style={({ pressed }) => [styles.row, styles.rowSettled, pressed && styles.pressed]}
        onPress={onToggleExpanded}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={NATIVE_CHAT_TURN_STATUS_COPY.toggleDetails}
      >
        <Text style={styles.label}>{label}</Text>
        <View style={expanded ? styles.caretOpen : undefined}>
          <ChevronRight size={14} color={colors.textMuted} strokeWidth={2} />
        </View>
      </Pressable>
    )
  }

  return (
    <View
      style={[styles.row, settled ? styles.rowSettled : null]}
      accessibilityLiveRegion="polite"
      accessibilityLabel={NATIVE_CHAT_TURN_STATUS_COPY.responding}
    >
      {settled ? null : <ActivityIndicator size="small" color={colors.textMuted} />}
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 28,
    paddingHorizontal: spacing.md
  },
  rowSettled: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  pressed: {
    opacity: 0.6
  },
  label: {
    color: colors.textMuted,
    fontSize: typography.bodySize,
    flexShrink: 1
  },
  caretOpen: {
    transform: [{ rotate: '90deg' }]
  }
})
