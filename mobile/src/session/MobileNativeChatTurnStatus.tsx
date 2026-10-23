import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import {
  formatNativeChatTurnStatusLabel,
  NATIVE_CHAT_TURN_STATUS_COPY,
  nativeChatElapsedSeconds
} from '../../../src/shared/native-chat-turn-status'
import type { AgentTurnOutcome } from '../../../src/shared/agent-turn-outcome'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import { MobileNativeChatDisclosureRow } from './MobileNativeChatDisclosureRow'

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

/** The turn bar under the user's message: "Working for 12s" while the turn runs,
 *  settling in place to a tappable "Worked for 3m 4s" ("Interrupted after" for a Stop,
 *  "Failed after" for a fault) that discloses the turn's tool activity. Desktop parity:
 *  `NativeChatWorkingStatus`. */
export function MobileNativeChatTurnStatus({
  startedAt,
  workedSeconds,
  verdict,
  expanded = false,
  onToggleExpanded
}: {
  startedAt: number | null
  workedSeconds?: number | null
  /** How a settled turn ended; it picks the settled label. */
  verdict?: AgentTurnOutcome
  expanded?: boolean
  onToggleExpanded?: () => void
}): React.JSX.Element {
  const settled = workedSeconds != null
  const elapsedSeconds = useElapsedSeconds(startedAt, !settled)
  const label = formatNativeChatTurnStatusLabel({ workedSeconds, elapsedSeconds, verdict })

  if (settled && onToggleExpanded) {
    return (
      <View style={styles.bar}>
        <MobileNativeChatDisclosureRow
          onPress={onToggleExpanded}
          expanded={expanded}
          accessibilityLabel={NATIVE_CHAT_TURN_STATUS_COPY.toggleDetails}
        >
          <Text style={styles.label}>{label}</Text>
        </MobileNativeChatDisclosureRow>
      </View>
    )
  }

  return (
    <View style={styles.bar}>
      <MobileNativeChatDisclosureRow>
        <Text style={[styles.label, !settled && styles.labelLive]} numberOfLines={1}>
          {label}
        </Text>
      </MobileNativeChatDisclosureRow>
    </View>
  )
}

// Inset like the message rows, so "Worked for 3m" sits on the transcript's text edge. No rule or
// box: the clock is a quiet line between your message and the agent's work.
const styles = StyleSheet.create({
  bar: {
    paddingHorizontal: spacing.lg
  },
  labelLive: {
    color: colors.textSecondary
  },
  label: {
    ...textStyles.callout,
    flexShrink: 1,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  }
})
