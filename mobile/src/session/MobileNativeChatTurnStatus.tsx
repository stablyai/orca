import { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import {
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

/** The per-turn status row — "Thinking", then "Working for 12s" while the turn
 *  runs, settling to a tappable "Worked for 3m 4s" that discloses the turn's
 *  tool activity. Desktop parity: `NativeChatWorkingStatus`. */
export function MobileNativeChatTurnStatus({
  startedAt,
  thinking,
  workedSeconds,
  expanded = false,
  onToggleExpanded
}: {
  startedAt: number | null
  thinking: boolean
  workedSeconds?: number | null
  expanded?: boolean
  onToggleExpanded?: () => void
}): React.JSX.Element {
  const counting = !thinking && workedSeconds == null
  const elapsedSeconds = useElapsedSeconds(startedAt, counting)
  const label = formatNativeChatTurnStatusLabel({ thinking, workedSeconds, elapsedSeconds })

  const pulse = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (!thinking) {
      pulse.setValue(1)
      return
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.45, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true })
      ])
    )
    animation.start()
    return () => animation.stop()
  }, [pulse, thinking])

  const rowStyle = [styles.row, thinking ? null : styles.rowSettled]

  if (workedSeconds != null && onToggleExpanded) {
    return (
      <Pressable
        style={({ pressed }) => [...rowStyle, pressed && styles.pressed]}
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
      style={rowStyle}
      accessibilityLiveRegion="polite"
      accessibilityLabel={NATIVE_CHAT_TURN_STATUS_COPY.responding}
    >
      <Animated.Text style={[styles.label, thinking && { opacity: pulse }]}>{label}</Animated.Text>
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
    fontSize: typography.bodySize
  },
  caretOpen: {
    transform: [{ rotate: '90deg' }]
  }
})
