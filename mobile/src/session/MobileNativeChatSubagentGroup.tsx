import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { Bot, ChevronRight } from 'lucide-react-native'
import {
  formatSubagentTokens,
  nativeChatSubagentGroupHeader,
  sayNativeChatSubagentGroupEnglish as say,
  subagentStateLabel
} from '../../../src/shared/native-chat-subagent-group-header'
import { normalizeSubagentState } from '../../../src/shared/native-chat-subagent-summary'
import { formatNativeChatDuration } from '../../../src/shared/native-chat-turn-status'
import type {
  NativeChatSubagentGroupBlock,
  NativeChatSubagentState
} from '../../../src/shared/native-chat-types'
import { useNow } from '../hooks/use-now'
import { colors, spacing, typography } from '../theme/mobile-theme'

// Desktop's StatusDot tones: the working and failed states speak; every settled one stays muted.
function stateDotStyle(state: NativeChatSubagentState): ViewStyle {
  switch (state) {
    case 'working':
      return { backgroundColor: colors.textPrimary }
    case 'failed':
      return { backgroundColor: colors.statusRed }
    case 'idle':
      return { backgroundColor: colors.textMuted, opacity: 0.4 }
    case 'completed':
      return { backgroundColor: colors.textMuted, opacity: 0.6 }
    case 'stopped':
    case 'unverifiable':
      return { backgroundColor: colors.textMuted }
  }
}

/** Leaf so the 1 s clock re-renders only the digits, never the row or its message. */
function Elapsed({
  startedAt,
  settledAt,
  counting
}: {
  startedAt: number
  settledAt: number | null
  counting: boolean
}): React.JSX.Element {
  const now = useNow(1_000, counting)
  const end = counting ? now : (settledAt ?? now)
  return <>{formatNativeChatDuration(Math.max(0, (end - startedAt) / 1000))}</>
}

/** One spawn group's row: how many children work, their settled verdict, how long and how many
 *  tokens, with one line per child under it. Live because the host rewrites the row in place, and
 *  drawn exactly as the journal recorded it — a turn boundary is never evidence a child stopped.
 *  Desktop parity: `NativeChatSubagentRun`, from the same shared header; a child's own rows do not
 *  open here, so its line is not a control. */
export function MobileNativeChatSubagentGroup({
  block,
  open,
  onToggle
}: {
  block: NativeChatSubagentGroupBlock
  /** Held by the transcript, keyed by group, so a recycled list row keeps it. */
  open: boolean
  onToggle?: (groupId: string) => void
}): React.JSX.Element | null {
  const header = nativeChatSubagentGroupHeader(block.agents, say)
  if (header.total === 0) {
    return null
  }
  const { working, headline, verdictState, verdict, alertState, alert, clockStartedAt } = header
  // Spoken whole, as the live line's is: a working group's clock would otherwise make the live
  // region re-read the row every second (nested Text spans cannot opt out on their own).
  const settledElapsed =
    !working && clockStartedAt !== null && header.settledAt !== null
      ? formatNativeChatDuration(Math.max(0, (header.settledAt - clockStartedAt) / 1000))
      : null
  const accessibilityLabel = [
    headline,
    alert === null ? verdict : `${verdict} +${alert}`,
    settledElapsed,
    header.tokens
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
  return (
    <View testID="subagent-group" style={styles.group}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={accessibilityLabel}
        accessibilityLiveRegion="polite"
        hitSlop={6}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
        onPress={() => onToggle?.(block.groupId)}
      >
        <Bot size={14} color={colors.textMuted} strokeWidth={2} />
        <View style={[styles.dot, stateDotStyle(alertState ?? verdictState)]} />
        <Text style={[styles.headline, working && styles.headlineWorking]} numberOfLines={1}>
          {headline}
        </Text>
        {/* Wraps under itself rather than pushing the headline or chevron out of a phone row. */}
        <Text style={styles.verdict}>
          {verdict}
          {alert === null ? null : ` +${alert}`}
          {clockStartedAt !== null ? (
            <>
              {' · '}
              <Elapsed startedAt={clockStartedAt} settledAt={header.settledAt} counting={working} />
            </>
          ) : null}
          {header.tokens !== null ? ` · ${header.tokens}` : null}
        </Text>
        <View style={open ? styles.caretOpen : undefined}>
          <ChevronRight size={14} color={colors.textMuted} strokeWidth={2} />
        </View>
      </Pressable>
      {open
        ? block.agents.map((agent) => {
            const state = normalizeSubagentState(agent.state)
            return (
              <View key={agent.id} testID="subagent-group-entry" style={styles.entry}>
                <View style={[styles.dot, stateDotStyle(state)]} />
                <Text
                  style={[styles.entryLabel, state === 'idle' && styles.entryLabelIdle]}
                  numberOfLines={1}
                >
                  {agent.label}
                </Text>
                <Text style={styles.entryState} numberOfLines={1}>
                  {subagentStateLabel(state, 1, 1, say)}
                  {typeof agent.tokens === 'number'
                    ? ` · ${formatSubagentTokens(agent.tokens)}`
                    : null}
                </Text>
              </View>
            )
          })
        : null}
    </View>
  )
}

const styles = StyleSheet.create({
  group: {
    paddingVertical: spacing.xs
  },
  header: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  pressed: {
    opacity: 0.6
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3
  },
  headline: {
    flexShrink: 0,
    maxWidth: '60%',
    color: colors.textMuted,
    fontSize: typography.bodySize
  },
  headlineWorking: {
    color: colors.textPrimary
  },
  verdict: {
    flex: 1,
    minWidth: 0,
    textAlign: 'right',
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  entryState: {
    marginLeft: 'auto',
    flexShrink: 0,
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  caretOpen: {
    transform: [{ rotate: '90deg' }]
  },
  entry: {
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.lg + spacing.xs
  },
  entryLabel: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: typography.metaSize
  },
  entryLabelIdle: {
    color: colors.textMuted
  }
})
